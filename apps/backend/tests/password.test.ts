import { encodeBase64 } from "@oslojs/encoding";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/platform/auth/password.ts";

const PASSWORD = "a-long-enough-password";

describe("verifyPassword", () => {
  let stored: string;
  let salt: string;
  let hash: string;

  beforeAll(async () => {
    stored = await hashPassword(PASSWORD);
    [, , salt, hash] = stored.split("$") as [string, string, string, string];
  });

  const cases: Array<[string, () => [string, string], boolean]> = [
    ["accepts the right password", () => [PASSWORD, stored], true],
    [
      "refuses a wrong password",
      () => ["another-long-password", stored],
      false,
    ],
    [
      "refuses a stored hash of a different length",
      () => [
        PASSWORD,
        `pbkdf2-sha256$100000$${salt}$${encodeBase64(new Uint8Array(16))}`,
      ],
      false,
    ],
    [
      "refuses a non-numeric iteration count",
      () => [PASSWORD, "pbkdf2-sha256$abc$x$y"],
      false,
    ],
    [
      "refuses a fractional iteration count",
      () => [PASSWORD, `pbkdf2-sha256$1.5$${salt}$${hash}`],
      false,
    ],
    [
      "refuses malformed base64",
      () => [PASSWORD, "pbkdf2-sha256$100000$!!$!!"],
      false,
    ],
    [
      "refuses an iteration count above the Workers cap",
      () => [PASSWORD, `pbkdf2-sha256$200000$${salt}$${hash}`],
      false,
    ],
    [
      "refuses another scheme",
      () => [PASSWORD, `bcrypt$100000$${salt}$${hash}`],
      false,
    ],
  ];

  it.each(cases)("%s", async (_name, input, expected) => {
    const [password, value] = input();
    expect(await verifyPassword(password, value)).toBe(expected);
  });
});
