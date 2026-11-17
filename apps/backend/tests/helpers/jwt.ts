import { encodeBase64urlNoPadding } from "@oslojs/encoding";

/**
 * A token shaped like the one Cálidda's login returns. The client only reads
 * its payload, so the signature is a placeholder.
 */
export function fakeJwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) =>
    encodeBase64urlNoPadding(new TextEncoder().encode(JSON.stringify(value)));
  return `${part({ alg: "HS256", typ: "JWT" })}.${part(payload)}.signature`;
}
