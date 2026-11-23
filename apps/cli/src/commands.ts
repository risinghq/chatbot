import {
  isTenantSecretSettingKey,
  parseCents,
  type StockRow,
} from "@vendeya/types";

/** What a command may use. `call` already carries the token. */
export type CommandContext = {
  args: string[];
  options: {
    name?: string;
    role?: string;
    data?: string;
    category?: string;
    cost?: string;
    location?: string;
    note?: string;
    status?: string;
    phone?: string;
    channel?: string;
    zone?: string;
    address?: string;
    method?: string;
    reference?: string;
    yes?: boolean;
  };
  call(method: string, path: string, body?: unknown): Promise<unknown>;
  /**
   * Names `business` on every later request, once the server confirms the
   * account can open it, or names none. Answers the account as seen there.
   */
  useBusiness(business: string | null): Promise<unknown>;
  /** All of stdin, trimmed. Secrets arrive here, never in arguments. */
  readStdin(): Promise<string>;
  /** A local file's bytes. Throws UsageError when it does not exist. */
  readFile(path: string): Promise<File>;
};

export type Command = {
  /** The words that select it, such as `businesses create`. */
  words: string;
  usage: string;
  summary: string;
  run(ctx: CommandContext): Promise<unknown>;
};

const ASSISTANT_TEXT_FIELDS = ["instructions", "faq", "policies"];

/** A usage mistake. The CLI prints it with the command's usage and exits 2. */
export class UsageError extends Error {}

function need<T>(value: T | undefined | "", what: string): T {
  if (value === undefined || value === "")
    throw new UsageError(`Missing ${what}.`);
  return value;
}

function noMoreArgs(ctx: CommandContext, count: number) {
  if (ctx.args.length > count) {
    throw new UsageError(`Unexpected argument: ${ctx.args[count]}`);
  }
}

/** A destructive command runs only with --yes, so an agent states its intent. */
function confirmed(ctx: CommandContext, action: string) {
  if (!ctx.options.yes) throw new UsageError(`${action} needs --yes.`);
}

function imagesPath(productId: string): string {
  return `/api/catalog/products/${encodeURIComponent(productId)}/images`;
}

function cents(text: string | undefined, what: string): number {
  const value = parseCents(need(text, what));
  if (value === null)
    throw new UsageError(`${what} is an amount such as 49.90.`);
  return value;
}

function wholeNumber(text: string | undefined, what: string): number {
  const value = Number(need(text, what));
  if (!Number.isInteger(value))
    throw new UsageError(`${what} is a whole number.`);
  return value;
}

/** Records one stock movement for the variant with `sku`. */
async function moveStock(
  ctx: CommandContext,
  kind: "receive" | "adjust",
): Promise<unknown> {
  noMoreArgs(ctx, 2);
  const sku = need(ctx.args[0], "SKU");
  const quantity = wholeNumber(ctx.args[1], "quantity");
  const rows = (await ctx.call("GET", "/api/stock")) as StockRow[];
  const row = rows.find((r) => r.sku === sku);
  if (!row) throw new UsageError(`No variant has SKU ${sku}.`);
  return ctx.call("POST", "/api/stock/movements", {
    variant_id: row.variant_id,
    location_id: ctx.options.location,
    kind,
    quantity,
    note: ctx.options.note ?? null,
  });
}

function orderPath(id: string, rest = ""): string {
  return `/api/orders/${encodeURIComponent(id)}${rest}`;
}

/** `<sku>=<quantity>` arguments as order lines, each SKU resolved to its variant. */
async function orderLines(
  ctx: CommandContext,
  specs: string[],
): Promise<{ variant_id: string; quantity: number }[]> {
  if (specs.length === 0) throw new UsageError("Missing <sku>=<quantity>.");
  const rows = (await ctx.call("GET", "/api/stock")) as StockRow[];
  return specs.map((spec) => {
    const at = spec.lastIndexOf("=");
    if (at <= 0)
      throw new UsageError(`Expected <sku>=<quantity>, got ${spec}.`);
    const sku = spec.slice(0, at);
    const row = rows.find((r) => r.sku === sku);
    if (!row) throw new UsageError(`No variant has SKU ${sku}.`);
    return {
      variant_id: row.variant_id,
      quantity: wholeNumber(spec.slice(at + 1), `quantity of ${sku}`),
    };
  });
}

/**
 * A method the business set up, by id or name, or else a name recorded as
 * given, such as a one-off transfer.
 */
async function paymentMethod(
  ctx: CommandContext,
  method: string,
): Promise<{ method_id: string } | { method_name: string }> {
  const methods = (await ctx.call("GET", "/api/payment-methods")) as {
    id: string;
    name: string;
  }[];
  const lower = method.toLowerCase();
  const found = methods.find(
    (m) => m.id === method || m.name.toLowerCase() === lower,
  );
  return found ? { method_id: found.id } : { method_name: method };
}

type SimulatedMessage = {
  direction: "inbound" | "outbound";
  type: string;
  content: string;
};

/** The thread trimmed to what a reader acts on: the phase and the messages. */
async function simulatedThread(
  ctx: CommandContext,
  phone: string,
): Promise<{ phase: unknown; messages: SimulatedMessage[] }> {
  const thread = (await ctx.call(
    "GET",
    `/api/simulator/conversation/${encodeURIComponent(phone)}`,
  )) as {
    conversation: { phase: unknown };
    messages: SimulatedMessage[];
  };
  return {
    phase: thread.conversation.phase,
    messages: thread.messages.map(({ direction, type, content }) => ({
      direction,
      type,
      content,
    })),
  };
}

export const COMMANDS: Command[] = [
  {
    words: "whoami",
    usage: "whoami",
    summary: "The account and business the token acts as.",
    run: (ctx) => ctx.call("GET", "/api/auth/me"),
  },
  {
    words: "businesses list",
    usage: "businesses list",
    summary: "Businesses the account can open.",
    run: (ctx) => ctx.call("GET", "/api/tenants"),
  },
  {
    words: "businesses create",
    usage: "businesses create --name <name>",
    summary: "Create a business (platform operators only).",
    run: (ctx) =>
      ctx.call("POST", "/api/tenants", {
        name: need(ctx.options.name, "--name"),
      }),
  },
  {
    words: "businesses use",
    usage: "businesses use <business id | none>",
    summary: "Act in a business from now on; `none` acts in none.",
    run: (ctx) => {
      noMoreArgs(ctx, 1);
      const id = need(ctx.args[0], "business id");
      return ctx.useBusiness(id === "none" ? null : id);
    },
  },
  {
    words: "setup",
    usage: "setup",
    summary: "What the active business still has to configure.",
    run: (ctx) => ctx.call("GET", "/api/admin/setup-status"),
  },
  {
    words: "settings get",
    usage: "settings get",
    summary: "The active business's settings. Secrets show only as _has_<key>.",
    run: (ctx) => ctx.call("GET", "/api/admin/settings"),
  },
  {
    words: "settings set",
    usage: "settings set <key>=<value> [<key>=<value> ...]",
    summary: "Change settings. Secrets go through `secrets set`.",
    run: (ctx) => {
      if (ctx.args.length === 0) throw new UsageError("Missing <key>=<value>.");
      const updates: Record<string, string> = {};
      for (const pair of ctx.args) {
        const at = pair.indexOf("=");
        if (at <= 0)
          throw new UsageError(`Expected <key>=<value>, got ${pair}.`);
        const key = pair.slice(0, at);
        if (isTenantSecretSettingKey(key)) {
          throw new UsageError(
            `${key} is a secret. Pipe it to \`secrets set ${key}\` instead.`,
          );
        }
        updates[key] = pair.slice(at + 1);
      }
      return ctx.call("POST", "/api/admin/settings", updates);
    },
  },
  {
    words: "secrets set",
    usage: "secrets set <key>   (value on stdin)",
    summary: "Store a secret such as openai_api_key, read from stdin.",
    run: async (ctx) => {
      noMoreArgs(ctx, 1);
      const key = need(ctx.args[0], "secret key");
      if (!isTenantSecretSettingKey(key)) {
        throw new UsageError(`${key} is not a secret setting.`);
      }
      const value = await ctx.readStdin();
      if (!value)
        throw new UsageError("The secret is empty; pipe it on stdin.");
      const result = (await ctx.call("POST", "/api/admin/settings", {
        [key]: value,
      })) as { rejected?: string[] };
      // The server echoes what it stored; a secret is reported by name only.
      return { stored: key, rejected: result.rejected ?? [] };
    },
  },
  {
    words: "members list",
    usage: "members list",
    summary: "People in the active business and their roles.",
    run: (ctx) => ctx.call("GET", "/api/admin/users"),
  },
  {
    words: "members invite",
    usage:
      "members invite <email> --role <admin|developer|supervisor|sales_agent>",
    summary: "Create a one-time invitation link.",
    run: (ctx) => {
      noMoreArgs(ctx, 1);
      return ctx.call("POST", "/api/admin/invitations", {
        email: need(ctx.args[0], "email"),
        role: need(ctx.options.role, "--role"),
      });
    },
  },
  {
    words: "invitations list",
    usage: "invitations list",
    summary: "Open invitations of the active business.",
    run: (ctx) => ctx.call("GET", "/api/admin/invitations"),
  },
  {
    words: "invitations revoke",
    usage: "invitations revoke <invitation id> --yes",
    summary: "Cancel an open invitation.",
    run: (ctx) => {
      noMoreArgs(ctx, 1);
      const id = need(ctx.args[0], "invitation id");
      confirmed(ctx, "Revoking an invitation");
      return ctx.call(
        "DELETE",
        `/api/admin/invitations/${encodeURIComponent(id)}`,
      );
    },
  },
  {
    words: "channels list",
    usage: "channels list",
    summary: "WhatsApp numbers of the active business.",
    run: (ctx) => ctx.call("GET", "/api/admin/channels"),
  },
  {
    words: "products list",
    usage: "products list",
    summary: "Products of the active business, with their variant count.",
    run: (ctx) => ctx.call("GET", "/api/catalog/products"),
  },
  {
    words: "products create",
    usage: "products create --name <name> --category <category>",
    summary: "Create a product; then add its variants.",
    run: (ctx) => {
      noMoreArgs(ctx, 0);
      return ctx.call("POST", "/api/catalog/products", {
        name: need(ctx.options.name, "--name"),
        category: need(ctx.options.category, "--category"),
      });
    },
  },
  {
    words: "variants list",
    usage: "variants list <product id>",
    summary: "A product's variants: SKU, price and cost in cents.",
    run: (ctx) => {
      noMoreArgs(ctx, 1);
      const id = need(ctx.args[0], "product id");
      return ctx.call(
        "GET",
        `/api/catalog/products/${encodeURIComponent(id)}/variants`,
      );
    },
  },
  {
    words: "variants add",
    usage:
      "variants add <product id> <sku> <price> [--name <option>] [--cost <amount>]",
    summary: "Add a sellable variant. Amounts are units, such as 49.90.",
    run: (ctx) => {
      noMoreArgs(ctx, 3);
      const id = need(ctx.args[0], "product id");
      return ctx.call(
        "POST",
        `/api/catalog/products/${encodeURIComponent(id)}/variants`,
        {
          sku: need(ctx.args[1], "SKU"),
          price_cents: cents(ctx.args[2], "price"),
          cost_cents:
            ctx.options.cost === undefined
              ? null
              : cents(ctx.options.cost, "--cost"),
          name: ctx.options.name ?? null,
        },
      );
    },
  },
  {
    words: "images list",
    usage: "images list <product id>",
    summary: "A product's photos in order; the first is the cover.",
    run: (ctx) => {
      noMoreArgs(ctx, 1);
      return ctx.call("GET", imagesPath(need(ctx.args[0], "product id")));
    },
  },
  {
    words: "images add",
    usage: "images add <product id> <file>...",
    summary: "Upload photos after the existing ones; each is fit to 1024 px.",
    run: async (ctx) => {
      const path = imagesPath(need(ctx.args[0], "product id"));
      const files = ctx.args.slice(1);
      if (files.length === 0) throw new UsageError("Missing file.");
      const added = [];
      for (const file of files) {
        const form = new FormData();
        form.append("image", await ctx.readFile(file));
        added.push(await ctx.call("POST", path, form));
      }
      return added;
    },
  },
  {
    words: "images cover",
    usage: "images cover <product id> <image id>",
    summary: "Make a photo the cover, keeping the others in order.",
    run: async (ctx) => {
      noMoreArgs(ctx, 2);
      const path = imagesPath(need(ctx.args[0], "product id"));
      const cover = need(ctx.args[1], "image id");
      const images = (await ctx.call("GET", path)) as { id: string }[];
      if (!images.some((image) => image.id === cover)) {
        throw new UsageError(`The product has no image ${cover}.`);
      }
      const rest = images.filter((image) => image.id !== cover);
      return ctx.call("PUT", `${path}/order`, {
        ids: [cover, ...rest.map((image) => image.id)],
      });
    },
  },
  {
    words: "images delete",
    usage: "images delete <image id> --yes",
    summary: "Delete a photo and its file.",
    run: (ctx) => {
      noMoreArgs(ctx, 1);
      const id = need(ctx.args[0], "image id");
      confirmed(ctx, "Deleting an image");
      return ctx.call(
        "DELETE",
        `/api/catalog/images/${encodeURIComponent(id)}`,
      );
    },
  },
  {
    words: "stock list",
    usage: "stock list [--location <location id>]",
    summary: "On hand, reserved and available per variant.",
    run: (ctx) => {
      noMoreArgs(ctx, 0);
      const location = ctx.options.location;
      return ctx.call(
        "GET",
        location
          ? `/api/stock?location_id=${encodeURIComponent(location)}`
          : "/api/stock",
      );
    },
  },
  {
    words: "stock locations",
    usage: "stock locations",
    summary: "Where the business keeps stock.",
    run: (ctx) => ctx.call("GET", "/api/stock/locations"),
  },
  {
    words: "stock receive",
    usage: "stock receive <sku> <quantity> [--location <id>] [--note <text>]",
    summary: "Add units that arrived.",
    run: (ctx) => moveStock(ctx, "receive"),
  },
  {
    words: "stock adjust",
    usage: "stock adjust <sku> [--location <id>] -- <signed quantity>",
    summary:
      "Correct stock after a count. Options go before `--`, which lets the quantity be negative.",
    run: (ctx) => moveStock(ctx, "adjust"),
  },
  {
    words: "customers list",
    usage: "customers list",
    summary: "Customers of the active business, newest first.",
    run: (ctx) => {
      noMoreArgs(ctx, 0);
      return ctx.call("GET", "/api/customers");
    },
  },
  {
    words: "customers show",
    usage: "customers show <customer id>",
    summary: "A customer with their addresses.",
    run: async (ctx) => {
      noMoreArgs(ctx, 1);
      const id = encodeURIComponent(need(ctx.args[0], "customer id"));
      const customer = (await ctx.call(
        "GET",
        `/api/customers/${id}`,
      )) as object;
      const addresses = await ctx.call("GET", `/api/customers/${id}/addresses`);
      return { ...customer, addresses };
    },
  },
  {
    words: "orders list",
    usage: "orders list [--status <status>]",
    summary: "Orders, newest first, with their payment state.",
    run: (ctx) => {
      noMoreArgs(ctx, 0);
      const status = ctx.options.status;
      return ctx.call(
        "GET",
        status
          ? `/api/orders?status=${encodeURIComponent(status)}`
          : "/api/orders",
      );
    },
  },
  {
    words: "orders show",
    usage: "orders show <order id>",
    summary: "An order with its customer, lines, payments and shipment.",
    run: (ctx) => {
      noMoreArgs(ctx, 1);
      return ctx.call("GET", orderPath(need(ctx.args[0], "order id")));
    },
  },
  {
    words: "orders create",
    usage:
      "orders create --phone <digits> --name <customer> <sku>=<quantity>... [--channel <id>] [--zone <id>] [--address <text>] [--note <text>]",
    summary:
      "Take an order and reserve its stock. --address ships it; without it the customer picks up.",
    run: async (ctx) => {
      const { options } = ctx;
      if (options.zone && !options.address) {
        throw new UsageError("--zone needs --address.");
      }
      return ctx.call("POST", "/api/orders", {
        customer: {
          phone: need(options.phone, "--phone"),
          name: need(options.name, "--name"),
        },
        channel_account_id: options.channel ?? null,
        lines: await orderLines(ctx, ctx.args),
        location_id: options.location ?? null,
        shipment: options.address
          ? { address_line: options.address, zone_id: options.zone ?? null }
          : null,
        notes: options.note ?? null,
      });
    },
  },
  {
    words: "orders status",
    usage:
      "orders status <order id> <confirmed|packed|shipped|delivered|cancelled>",
    summary:
      "Move an order on. Shipping takes its stock out; cancelling gives it back and needs --yes.",
    run: (ctx) => {
      noMoreArgs(ctx, 2);
      const id = need(ctx.args[0], "order id");
      const status = need(ctx.args[1], "status");
      if (status === "cancelled") confirmed(ctx, "Cancelling an order");
      return ctx.call("POST", orderPath(id, "/transition"), { status });
    },
  },
  {
    words: "payments add",
    usage:
      "payments add <order id> <amount> --method <method id or name> [--reference <operation number>]",
    summary:
      "Record a payment, pending until confirmed. An unknown method name is kept as given.",
    run: async (ctx) => {
      noMoreArgs(ctx, 2);
      const id = need(ctx.args[0], "order id");
      const amount = cents(ctx.args[1], "amount");
      return ctx.call("POST", orderPath(id, "/payments"), {
        ...(await paymentMethod(ctx, need(ctx.options.method, "--method"))),
        amount_cents: amount,
        reference: ctx.options.reference ?? null,
      });
    },
  },
  ...(["confirm", "reject"] as const).map(
    (action): Command => ({
      words: `payments ${action}`,
      usage: `payments ${action} <order id> <payment id>`,
      summary:
        action === "confirm"
          ? "Count a payment toward its order (admins and supervisors)."
          : "Mark a payment as not received (admins and supervisors).",
      run: (ctx) => {
        noMoreArgs(ctx, 2);
        const id = need(ctx.args[0], "order id");
        const payment = encodeURIComponent(need(ctx.args[1], "payment id"));
        return ctx.call(
          "POST",
          orderPath(id, `/payments/${payment}/${action}`),
        );
      },
    }),
  ),
  {
    words: "zones list",
    usage: "zones list",
    summary: "Delivery zones and their fee in cents.",
    run: (ctx) => ctx.call("GET", "/api/delivery-zones"),
  },
  {
    words: "zones add",
    usage: "zones add <fee> --name <zone>",
    summary: "Add a delivery zone. The fee is an amount such as 10.00.",
    run: (ctx) => {
      noMoreArgs(ctx, 1);
      return ctx.call("POST", "/api/delivery-zones", {
        name: need(ctx.options.name, "--name"),
        fee_cents: cents(ctx.args[0], "fee"),
      });
    },
  },
  {
    words: "methods list",
    usage: "methods list",
    summary: "Payment methods the business accepts.",
    run: (ctx) => ctx.call("GET", "/api/payment-methods"),
  },
  {
    words: "methods add",
    usage:
      "methods add --name <method> [--note <instructions for the customer>]",
    summary: "Add a payment method, such as Yape with its number.",
    run: (ctx) => {
      noMoreArgs(ctx, 0);
      return ctx.call("POST", "/api/payment-methods", {
        name: need(ctx.options.name, "--name"),
        instructions: ctx.options.note ?? null,
      });
    },
  },
  {
    words: "assistant show",
    usage: "assistant show",
    summary: "The assistant's instructions, FAQ, policies, model and location.",
    run: (ctx) => {
      noMoreArgs(ctx, 0);
      return ctx.call("GET", "/api/assistant/settings");
    },
  },
  {
    words: "assistant set",
    usage: "assistant set <setting> [model | location id | none]",
    summary:
      "Change instructions, faq or policies (text on stdin), model, or location.",
    run: async (ctx) => {
      const field = need(ctx.args[0], "setting");
      if (ASSISTANT_TEXT_FIELDS.includes(field)) {
        noMoreArgs(ctx, 1);
        return ctx.call("PUT", "/api/assistant/settings", {
          [field]: await ctx.readStdin(),
        });
      }
      noMoreArgs(ctx, 2);
      const value = need(ctx.args[1], "value");
      if (field === "model") {
        return ctx.call("PUT", "/api/assistant/settings", { model: value });
      }
      if (field === "location") {
        return ctx.call("PUT", "/api/assistant/settings", {
          stock_location_id: value === "none" ? null : value,
        });
      }
      throw new UsageError(`${field} is not an assistant setting.`);
    },
  },
  {
    words: "simulate list",
    usage: "simulate list",
    summary: "Simulated conversations of the active business.",
    run: (ctx) => ctx.call("GET", "/api/simulator/conversations"),
  },
  {
    words: "simulate start",
    usage: "simulate start",
    summary: "Start a simulated conversation; answers with its phone number.",
    run: async (ctx) => {
      noMoreArgs(ctx, 0);
      const conversation = (await ctx.call(
        "POST",
        "/api/simulator/conversations",
        {},
      )) as { phone_number: string };
      return { phone: conversation.phone_number };
    },
  },
  {
    words: "simulate say",
    usage: "simulate say <phone> <message...>",
    summary: "Write as the customer and print the assistant's replies.",
    run: async (ctx) => {
      const phone = need(ctx.args[0], "phone");
      const message = need(ctx.args.slice(1).join(" "), "message");
      await ctx.call("POST", "/api/simulator/message", {
        phoneNumber: phone,
        message,
      });
      const thread = await simulatedThread(ctx, phone);
      const lastInbound = thread.messages.findLastIndex(
        (m) => m.direction === "inbound",
      );
      return {
        phase: thread.phase,
        replies: thread.messages.slice(lastInbound + 1),
      };
    },
  },
  {
    words: "simulate show",
    usage: "simulate show <phone>",
    summary: "A simulated conversation's phase and messages.",
    run: (ctx) => {
      noMoreArgs(ctx, 1);
      return simulatedThread(ctx, need(ctx.args[0], "phone"));
    },
  },
  {
    words: "simulate delete",
    usage: "simulate delete <phone> --yes",
    summary: "Delete a simulated conversation.",
    run: (ctx) => {
      noMoreArgs(ctx, 1);
      const phone = need(ctx.args[0], "phone");
      confirmed(ctx, "Deleting a simulation");
      return ctx.call(
        "DELETE",
        `/api/simulator/conversations/${encodeURIComponent(phone)}`,
      );
    },
  },
  {
    words: "tokens list",
    usage: "tokens list",
    summary: "The account's API tokens (never their secret).",
    run: (ctx) => ctx.call("GET", "/api/auth/tokens"),
  },
  {
    words: "tokens revoke",
    usage: "tokens revoke <token id> --yes",
    summary: "End an API token at once.",
    run: (ctx) => {
      noMoreArgs(ctx, 1);
      const id = need(ctx.args[0], "token id");
      confirmed(ctx, "Revoking a token");
      return ctx.call("DELETE", `/api/auth/tokens/${encodeURIComponent(id)}`);
    },
  },
  {
    words: "api",
    usage:
      "api <GET|POST|PATCH|PUT|DELETE> </api/...> [--data <json> | --data -]",
    summary:
      "Any endpoint, with the same token and checks. DELETE needs --yes.",
    run: async (ctx) => {
      noMoreArgs(ctx, 2);
      const method = need(ctx.args[0], "method").toUpperCase();
      const apiPath = need(ctx.args[1], "path");
      if (!["GET", "POST", "PATCH", "PUT", "DELETE"].includes(method)) {
        throw new UsageError(`Unknown method ${method}.`);
      }
      if (!apiPath.startsWith("/api/")) {
        throw new UsageError("The path starts with /api/.");
      }
      if (method === "DELETE") confirmed(ctx, "DELETE");
      const raw =
        ctx.options.data === "-" ? await ctx.readStdin() : ctx.options.data;
      let body: unknown;
      if (raw !== undefined) {
        try {
          body = JSON.parse(raw);
        } catch {
          throw new UsageError("--data is not valid JSON.");
        }
      }
      return ctx.call(method, apiPath, body);
    },
  },
];

/** The command named by the leading words of `argv`, longest match first. */
export function findCommand(
  argv: string[],
): { command: Command; args: string[] } | null {
  for (const length of [2, 1]) {
    const words = argv.slice(0, length).join(" ");
    const command = COMMANDS.find((c) => c.words === words);
    if (command) return { command, args: argv.slice(length) };
  }
  return null;
}
