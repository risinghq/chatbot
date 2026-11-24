import { newId } from "@vendeya/utils";
import process from "node:process";
import { parseArgs } from "node:util";
import type { CliOperator } from "../platform/audit/logger.ts";
import { currentOperator } from "./os-user.ts";
import { withPlatform } from "./platform.ts";
import { readSecret } from "./read-password.ts";

const USAGE = `Usage:
  bun run account create <email> [--platform-operator | --tenant <tenant id>] [--name <display name>]
  bun run account promote <email>
  bun run account tenant create --name <business name>
  bun run account channel create --tenant <tenant id> --phone-number-id <id>
      [--waba-id <id>] [--display-phone-number <number>] [--label <label>]
      [--instagram]
  bun run account token create <email> --name <token name> [--days <1-365>]

\`token create\` prints a new API token for the account on stdout, once. It is
how the first token reaches a program; after that, mint tokens on the
dashboard (Mi cuenta).

\`--instagram\` registers an Instagram professional account instead of a
WhatsApp number: \`--phone-number-id\` takes the account's Instagram id.

Every command writes to the local D1
database that \`bun run dev\` uses. Add --remote to write to the deployed one,
which reads CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN from the
environment.

A password or an access token is read from a hidden prompt, or from stdin when
stdin is not a terminal. It is never taken from arguments or the environment.
An empty access token creates the number as pending.`;

type Options = {
  "platform-operator"?: boolean;
  tenant?: string;
  name?: string;
  "phone-number-id"?: string;
  "waba-id"?: string;
  "display-phone-number"?: string;
  label?: string;
  instagram?: boolean;
  days?: string;
  remote?: boolean;
};

function usage(problem?: string): number {
  console.error(problem ? `${problem}\n\n${USAGE}` : USAGE);
  return 2;
}

function refuse(message: string): number {
  console.error(`error: ${message}`);
  return 1;
}

function parse(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        "platform-operator": { type: "boolean" },
        tenant: { type: "string" },
        name: { type: "string" },
        "phone-number-id": { type: "string" },
        "waba-id": { type: "string" },
        "display-phone-number": { type: "string" },
        label: { type: "string" },
        instagram: { type: "boolean" },
        days: { type: "string" },
        remote: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch {
    // The parser's message can quote the offending argument, which may be a secret.
    return null;
  }
}

async function main(argv: string[]): Promise<number> {
  const args = parse(argv);
  if (!args) return usage("Unrecognised or incomplete option.");

  const { help, remote, ...options } = args.values;
  if (help) {
    console.log(USAGE);
    return 0;
  }

  const [command, ...rest] = args.positionals;
  const operator = currentOperator();
  const go = (task: () => Promise<number>) =>
    withPlatform({ remote: remote === true }, task);

  switch (command) {
    case "create":
    case "promote": {
      const [email, ...extra] = rest;
      if (!email || extra.length > 0) return usage("Expected one email.");
      if (command === "promote" && Object.keys(options).length > 0) {
        return usage("promote takes an email and nothing else.");
      }
      return go(() =>
        command === "promote"
          ? promote(email, operator)
          : createAccount(email, options, operator),
      );
    }
    case "tenant": {
      const [verb, ...extra] = rest;
      if (verb !== "create" || extra.length > 0 || !options.name) {
        return usage("Expected `tenant create --name <name>`.");
      }
      return go(() => createTenant(options.name!, operator));
    }
    case "channel": {
      const [verb, ...extra] = rest;
      if (
        verb !== "create" ||
        extra.length > 0 ||
        !options.tenant ||
        !options["phone-number-id"]
      ) {
        return usage(
          "Expected `channel create --tenant <tenant> --phone-number-id <id>`.",
        );
      }
      return go(() => createChannel(options, operator));
    }
    case "token": {
      const [verb, email, ...extra] = rest;
      if (verb !== "create" || !email || extra.length > 0 || !options.name) {
        return usage("Expected `token create <email> --name <name>`.");
      }
      return go(() => createToken(email, options, operator));
    }
    default:
      return usage(command ? "Unknown command." : undefined);
  }
}

async function promote(email: string, operator: CliOperator) {
  const { AccountService } = await import("../domains/accounts/index.ts");
  const promoted = await AccountService.promote(email, operator);
  if (!promoted.ok) return refuse(promoted.error.message);

  console.log(
    promoted.value.changed
      ? `Promoted ${promoted.value.email} to platform operator.`
      : `${promoted.value.email} is already a platform operator; nothing changed.`,
  );
  return 0;
}

async function createAccount(
  email: string,
  options: Options,
  operator: CliOperator,
) {
  const { AccountService } = await import("../domains/accounts/index.ts");

  const request = {
    email,
    name: options.name,
    platformOperator: options["platform-operator"],
    tenantId: options.tenant,
  };

  // Refused before the prompt, so nobody types a password twice for nothing.
  const checked = await AccountService.checkNew(request);
  if (!checked.ok) return refuse(checked.error.message);

  const created = await AccountService.create(
    { ...request, password: await readSecret("Password") },
    operator,
  );
  if (!created.ok) return refuse(created.error.message);

  const { value } = created;
  console.log(
    value.tenant
      ? `Created ${value.email} as admin of tenant ${value.tenant.name} (${value.tenant.id}).`
      : `Created platform operator ${value.email}.`,
  );
  return 0;
}

async function createTenant(name: string, operator: CliOperator) {
  const { TenantService } = await import("../domains/tenants/index.ts");
  const { cliAuditStatement } = await import("../platform/audit/logger.ts");
  const { batch } = await import("../db/index.ts");

  const checked = TenantService.checkName(name);
  if ("problem" in checked) return refuse(checked.problem);

  const id = newId();
  await batch([
    TenantService.createStatement({ id, name: checked.name }),
    cliAuditStatement(operator, id, "create_tenant", "tenant", id, {
      name: checked.name,
    }),
  ]);
  console.log(`Created tenant ${checked.name} (${id}).`);
  return 0;
}

async function createChannel(options: Options, operator: CliOperator) {
  const { ChannelAccountService } = await import(
    "../domains/channels/accounts.ts"
  );
  const { isEncryptionAvailable } = await import(
    "../platform/crypto/secrets.ts"
  );
  const { cliAuditStatement } = await import("../platform/audit/logger.ts");
  const { batch } = await import("../db/index.ts");

  // The verify token is generated and stored encrypted on create, so a
  // channel account can never be created without the key.
  if (!isEncryptionAvailable()) {
    return refuse(
      "SECRETS_KEY is not set, so the channel account cannot be created.",
    );
  }

  const { TenantService } = await import("../domains/tenants/index.ts");
  const tenant = await TenantService.getById(options.tenant!);
  if (!tenant) return refuse(`No tenant has the id ${options.tenant}.`);

  const phoneNumberId = options["phone-number-id"]!;
  const channelType = options.instagram ? "instagram" : "whatsapp";
  if (
    await ChannelAccountService.getByPhoneNumberId(phoneNumberId, channelType)
  ) {
    return refuse(`That ${channelType} id is already registered.`);
  }

  const accessToken = await readSecret("Access token");
  const appSecret = await readSecret("App secret");

  const account = await ChannelAccountService.create({
    tenantId: tenant.id,
    channelType,
    phoneNumberId,
    wabaId: options["waba-id"] ?? null,
    displayPhoneNumber: options["display-phone-number"] ?? null,
    label: options.label ?? null,
    accessToken: accessToken || null,
    appSecret: appSecret || null,
  });
  await batch([
    cliAuditStatement(
      operator,
      tenant.id,
      "create_channel_account",
      "channel_account",
      account.id,
      { phoneNumberId, wabaId: account.waba_id, channelType },
    ),
  ]);

  console.log(
    `Created ${account.status} channel account ${account.id} for tenant ${tenant.name}.`,
  );
  return 0;
}

async function createToken(
  email: string,
  options: Options,
  operator: CliOperator,
) {
  const { checkTokenRequest, createApiToken } = await import(
    "../platform/auth/api-tokens.ts"
  );
  const { normalizeEmail } = await import("../domains/accounts/index.ts");
  const { cliAuditStatement } = await import("../platform/audit/logger.ts");
  const { batch, withoutTenantScope } = await import("../db/index.ts");

  const checked = checkTokenRequest({
    name: options.name,
    days: options.days === undefined ? undefined : Number(options.days),
  });
  if ("problem" in checked) return refuse(checked.problem);

  const address = normalizeEmail(email);
  const user = address
    ? await withoutTenantScope("a user account is keyed by its email")
        .selectFrom("users")
        .select(["id", "is_active"])
        .where("email", "=", address)
        .executeTakeFirst()
    : undefined;
  if (!user || user.is_active === 0) {
    return refuse(`No active account has the email ${email}.`);
  }

  const created = await createApiToken(user.id, checked, null);
  await batch([
    cliAuditStatement(
      operator,
      null,
      "create_api_token",
      "api_token",
      created.id,
      {
        userId: user.id,
        name: created.name,
        expiresAt: created.expires_at,
      },
    ),
  ]);

  // The token alone goes to stdout so a caller can pipe it into a file.
  console.error(
    `Created token "${created.name}", valid until ${new Date(created.expires_at).toISOString()}.`,
  );
  console.log(created.token);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
