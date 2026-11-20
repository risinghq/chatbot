import { isTenantSecretSettingKey } from "@vendeya/types";

/** What a command may use. `call` already carries the token. */
export type CommandContext = {
  args: string[];
  options: {
    name?: string;
    role?: string;
    data?: string;
    yes?: boolean;
  };
  call(method: string, path: string, body?: unknown): Promise<unknown>;
  /** All of stdin, trimmed. Secrets arrive here, never in arguments. */
  readStdin(): Promise<string>;
};

export type Command = {
  /** The words that select it, such as `businesses create`. */
  words: string;
  usage: string;
  summary: string;
  run(ctx: CommandContext): Promise<unknown>;
};

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
    summary:
      "Point the token at a business; `none` is the operator's cross-business view.",
    run: (ctx) => {
      noMoreArgs(ctx, 1);
      const id = need(ctx.args[0], "business id");
      return ctx.call("POST", "/api/tenants/active", {
        tenantId: id === "none" ? null : id,
      });
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
