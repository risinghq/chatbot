import { vi } from "vitest";
import { TEST_BINDINGS } from "../bindings.ts";
import { ChannelAccountService } from "../../src/domains/channels/accounts.ts";
import type { TenantFixture } from "./tenancy.ts";

export type GraphSend = {
  phoneNumberId: string;
  token: string | null;
  payload: Record<string, unknown>;
};

type Reply = () => Response | Promise<Response>;

const accepted: Reply = () =>
  Response.json({ messages: [{ id: `wamid.${crypto.randomUUID()}` }] });

/**
 * Stands in for Meta's Graph API. Every `fetch` to GRAPH_API_BASE_URL is
 * recorded and answered with `reply`, which accepts the message by default.
 * Any other URL fails the test, so nothing reaches the network.
 *
 * The test, the backend's routes and its Durable Objects share one isolate
 * under the Workers pool, so the spy sees every send.
 */
export function fakeGraph() {
  const sends: GraphSend[] = [];
  let reply: Reply = accepted;

  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== TEST_BINDINGS.GRAPH_API_BASE_URL) {
        throw new Error(`Unexpected fetch to ${request.url}`);
      }

      const [, , phoneNumberId] = url.pathname.split("/");
      sends.push({
        phoneNumberId: phoneNumberId ?? "",
        token:
          request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null,
        payload: (await request.json()) as Record<string, unknown>,
      });
      return reply();
    });

  return {
    sends,
    /** Answers every later send with `next`. */
    respondWith(next: Reply) {
      reply = next;
    },
    /** Messages to a customer, leaving out read receipts. */
    replies(): GraphSend[] {
      return sends.filter((send) => send.payload.status !== "read");
    },
    /**
     * The message ids marked read. A turn marks its group's newest message, so
     * each entry is one turn.
     */
    readReceipts(): string[] {
      return sends
        .filter((send) => send.payload.status === "read")
        .map((send) => send.payload.message_id as string);
    },
    /** The text bodies sent to `to`, in order. */

    textsTo(to: string): string[] {
      return sends
        .filter(
          (send) => send.payload.to === to && send.payload.type === "text",
        )
        .map((send) => (send.payload.text as { body: string }).body);
    },
    restore() {
      spy.mockRestore();
    },
  };
}

/** Meta refusing a send outright, as for a number outside the 24 h window. */
export const permanentFailure: Reply = () =>
  Response.json(
    { error: { code: 131047, message: "Re-engagement message" } },
    { status: 400 },
  );

/** Gives the fixture's number an access token, so a send can reach Meta. */
export async function withAccessToken(
  tenant: TenantFixture,
  token = `token-${tenant.tenantId}`,
): Promise<string> {
  const account = await ChannelAccountService.getById(tenant.channelAccountId);
  if (!account) throw new Error("fixture channel account is missing");
  await ChannelAccountService.update(account, { accessToken: token });
  return token;
}
