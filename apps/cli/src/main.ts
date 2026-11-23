#!/usr/bin/env bun
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { ApiError, callApi, type Fetch } from "./client.ts";
import { COMMANDS, findCommand, UsageError } from "./commands.ts";
import {
  DEFAULT_URL,
  forgetCredentials,
  type Credentials,
  resolveCredentials,
  storeBusiness,
  storeCredentials,
} from "./credentials.ts";

export type Io = {
  env: NodeJS.ProcessEnv;
  stdout(text: string): void;
  stderr(text: string): void;
  readStdin(): Promise<string>;
  readFile?(path: string): Promise<File>;
  fetcher?: Fetch;
};

async function readLocalFile(filePath: string): Promise<File> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new UsageError(`No such file: ${filePath}`);
  }
  return new File([await file.arrayBuffer()], basename(filePath), {
    type: file.type,
  });
}

const OPTIONS = {
  name: { type: "string" },
  role: { type: "string" },
  data: { type: "string" },
  category: { type: "string" },
  cost: { type: "string" },
  location: { type: "string" },
  note: { type: "string" },
  status: { type: "string" },
  phone: { type: "string" },
  channel: { type: "string" },
  zone: { type: "string" },
  address: { type: "string" },
  method: { type: "string" },
  reference: { type: "string" },
  url: { type: "string" },
  yes: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

function help(): string {
  const rows: [usage: string, summary: string][] = [
    [
      "login [--url <url>]",
      "Store a token read from stdin, after checking it.",
    ],
    ["logout", "Forget the stored token."],
    ...COMMANDS.map((c): [string, string] => [c.usage, c.summary]),
  ];
  const width = Math.max(...rows.map(([usage]) => usage.length));
  return [
    "vendeya: control a VendeYa business from a shell or an agent.",
    "",
    "Every answer is JSON on stdout; an error is JSON on stderr.",
    "Exit 0 on success, 1 when the server refuses, 2 on a usage mistake.",
    "VENDEYA_TOKEN, VENDEYA_URL and VENDEYA_BUSINESS override the stored login.",
    "",
    ...rows.map(([usage, summary]) => `  ${usage.padEnd(width)}  ${summary}`),
  ].join("\n");
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Runs one invocation and returns its exit code. */
export async function main(argv: string[], io: Io): Promise<number> {
  const fail = (code: number, error: string, extra: object = {}) => {
    io.stderr(json({ error, ...extra }));
    return code;
  };

  let parsed: ReturnType<
    typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
  >;
  try {
    parsed = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
    });
  } catch (error) {
    return fail(2, (error as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) {
    io.stdout(`${help()}\n`);
    return 0;
  }

  try {
    if (positionals[0] === "login") return await login(values.url, io);
    if (positionals[0] === "logout") {
      await forgetCredentials(io.env);
      io.stdout(json({ loggedOut: true }));
      return 0;
    }

    const found = findCommand(positionals);
    if (!found) return fail(2, `Unknown command: ${positionals.join(" ")}`);

    const credentials = await resolveCredentials(io.env);
    if (!credentials) {
      return fail(2, "Not logged in. Pipe a token to `vendeya login`.");
    }
    try {
      const result = await found.command.run({
        args: found.args,
        options: values,
        call: (method, path, body) =>
          callApi(credentials, method, path, body, io.fetcher),
        useBusiness: (business) => useBusiness(credentials, business, io),
        readStdin: io.readStdin,
        readFile: io.readFile ?? readLocalFile,
      });
      io.stdout(json(result));
      return 0;
    } catch (error) {
      if (error instanceof UsageError) {
        return fail(2, error.message, { usage: found.command.usage });
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof ApiError) {
      return fail(1, error.message, { status: error.status, body: error.body });
    }
    if (error instanceof UsageError) return fail(2, error.message);
    return fail(1, (error as Error).message);
  }
}

/**
 * The token arrives on stdin so it never sits in shell history or a process
 * list. It is stored only after the server accepts it.
 */
async function login(url: string | undefined, io: Io): Promise<number> {
  const token = await io.readStdin();
  if (!token) throw new UsageError("Pipe the token on stdin.");
  const credentials = {
    url: (url || io.env.VENDEYA_URL || DEFAULT_URL).replace(/\/+$/, ""),
    token,
  };
  const me = await callApi(
    credentials,
    "GET",
    "/api/auth/me",
    undefined,
    io.fetcher,
  );
  const file = await storeCredentials(io.env, credentials);
  io.stdout(json({ loggedIn: true, url: credentials.url, file, me }));
  return 0;
}

/**
 * The server answers /api/auth/me with 404 for a business the account cannot
 * open, so nothing is stored for it.
 */
async function useBusiness(
  credentials: Credentials,
  business: string | null,
  io: Io,
): Promise<unknown> {
  const { business: _current, ...login } = credentials;
  const me = await callApi(
    business ? { ...login, business } : login,
    "GET",
    "/api/auth/me",
    undefined,
    io.fetcher,
  );
  await storeBusiness(io.env, business);
  return { business, me };
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2), {
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readStdin: async () =>
      process.stdin.isTTY ? "" : (await Bun.stdin.text()).trim(),
  });
  process.exit(code);
}
