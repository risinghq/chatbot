import process from "node:process";
import { stripVTControlCharacters } from "node:util";

/**
 * A secret the operator types: on a terminal, a hidden prompt asked twice.
 * Otherwise one line from stdin. Never an argument or a variable, which a
 * shell history or a process list would keep.
 */
export async function readSecret(label = "Password"): Promise<string> {
  if (!process.stdin.isTTY) return readFromStdin(label);

  const secret = await promptHidden(`${label}: `);
  const confirmation = await promptHidden(`Confirm ${label.toLowerCase()}: `);

  if (secret !== confirmation) {
    throw new Error(`The ${label.toLowerCase()} entries do not match.`);
  }

  return secret;
}

async function readFromStdin(label: string): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const secret = Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");

  if (/[\r\n]/.test(secret)) {
    throw new Error(
      `Expected the ${label.toLowerCase()} on a single line of stdin.`,
    );
  }

  return secret;
}

function promptHidden(label: string): Promise<string> {
  const { stdin, stderr } = process;

  stderr.write(label);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();

  return new Promise((resolve, reject) => {
    const typed: string[] = [];

    function finish(settle: () => void) {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
      settle();
    }

    function onData(chunk: string) {
      // Escape sequences (arrow keys, paste markers) are not part of the password.
      const keys = stripVTControlCharacters(chunk);

      for (const key of keys) {
        if (key === "\r" || key === "\n")
          return finish(() => resolve(typed.join("")));
        if (key === "\u0003" || key === "\u0004") {
          return finish(() => reject(new Error("Cancelled.")));
        }
        if (key === "\u007f" || key === "\b") typed.pop();
        else if (key >= " ") typed.push(key);
      }
    }

    stdin.on("data", onData);
  });
}
