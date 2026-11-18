import process from "node:process";
import { parseArgs } from "node:util";
import type { CliOperator } from "../platform/audit/logger.ts";
import { currentOperator } from "./os-user.ts";
import { withPlatform } from "./platform.ts";
import { readSecret } from "./read-password.ts";

const USAGE = `Usage:
  bun run account create <username> [--platform-operator | --tenant <tenant>] [--name <display name>]
  bun run account promote <username>
  bun run account tenant create <slug> --name <business name>
  bun run account channel create --tenant <tenant> --phone-number-id <id>
      [--waba-id <id>] [--display-phone-number <number>] [--label <label>]

<tenant> is a tenant's id or slug. Every command writes to the local D1
database that \`bun run dev\` uses. Add --remote to write to the deployed one.

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
        remote: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch {
    // The parser's message can quote the offending argument, which may be a secret.
    return null;
  }
}

async function run(argv: string[]): Promise<number> {
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
      const [username, ...extra] = rest;
      if (!username || extra.length > 0) return usage("Expected one username.");
      if (command === "promote" && Object.keys(options).length > 0) {
        return usage("promote takes a username and nothing else.");
      }
      return go(() =>
        command === "promote"
          ? promote(username, operator)
          : createAccount(username, options, operator),
      );
    }
    case "tenant": {
      const [verb, slug, ...extra] = rest;
      if (verb !== "create" || !slug || extra.length > 0 || !options.name) {
        return usage("Expected `tenant create <slug> --name <name>`.");
      }
      return go(() => createTenant(slug, options.name!, operator));
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
    default:
      return usage(command ? "Unknown command." : undefined);
  }
}

async function promote(username: string, operator: CliOperator) {
  const { AccountService } = await import("../domains/accounts/index.ts");
  const promoted = await AccountService.promote(username, operator);
  if (!promoted.ok) return refuse(promoted.error.message);

  console.log(
    promoted.value.changed
      ? `Promoted ${promoted.value.username} to platform operator.`
      : `${promoted.value.username} is already a platform operator; nothing changed.`,
  );
  return 0;
}

async function createAccount(
  username: string,
  options: Options,
  operator: CliOperator,
) {
  const { AccountService } = await import("../domains/accounts/index.ts");
  const tenant = options.tenant ? await findTenant(options.tenant) : undefined;
  if (tenant === null)
    return refuse(`No tenant has the id or slug ${options.tenant}.`);

  const request = {
    username,
    name: options.name,
    platformOperator: options["platform-operator"],
    tenantId: tenant?.id,
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
      ? `Created ${value.username} as admin of tenant ${value.tenant.slug} (${value.tenant.id}).`
      : `Created platform operator ${value.username}.`,
  );
  return 0;
}

async function createTenant(slug: string, name: string, operator: CliOperator) {
  const { TenantService } = await import("../domains/tenants/index.ts");
  const { cliAuditStatement } = await import("../platform/audit/logger.ts");
  const { batch } = await import("../db/index.ts");

  const problem = await TenantService.newTenantProblem(slug, name);
  if (problem) return refuse(problem.message);

  const id = crypto.randomUUID();
  await batch([
    TenantService.createStatement({ id, slug, name }),
    cliAuditStatement(operator, id, "create_tenant", "tenant", id, {
      slug,
      name,
    }),
  ]);
  console.log(`Created tenant ${slug} (${id}).`);
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

  // The verify token is generated and stored encrypted on create, so a
  // channel account can never be created without the key.
  if (!isEncryptionAvailable()) {
    return refuse(
      "SECRETS_KEY is not set, so the channel account cannot be created.",
    );
  }

  const tenant = await findTenant(options.tenant!);
  if (!tenant) return refuse(`No tenant has the id or slug ${options.tenant}.`);

  const phoneNumberId = options["phone-number-id"]!;
  if (await ChannelAccountService.getByPhoneNumberId(phoneNumberId)) {
    return refuse("That phone number id is already registered.");
  }

  const accessToken = await readSecret("Access token");
  const appSecret = await readSecret("App secret");

  const account = await ChannelAccountService.create({
    tenantId: tenant.id,
    phoneNumberId,
    wabaId: options["waba-id"] ?? null,
    displayPhoneNumber: options["display-phone-number"] ?? null,
    label: options.label ?? null,
    accessToken: accessToken || null,
    appSecret: appSecret || null,
  });
  await cliAuditStatement(
    operator,
    tenant.id,
    "create_channel_account",
    "channel_account",
    account.id,
    { phoneNumberId, wabaId: account.waba_id },
  ).run();

  console.log(
    `Created ${account.status} channel account ${account.id} for tenant ${tenant.slug}.`,
  );
  return 0;
}

async function findTenant(idOrSlug: string) {
  const { TenantService } = await import("../domains/tenants/index.ts");
  return (
    (await TenantService.getById(idOrSlug)) ??
    (await TenantService.getBySlug(idOrSlug))
  );
}

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
