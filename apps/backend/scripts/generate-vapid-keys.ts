/**
 * Prints a VAPID key pair for Web Push. For local development copy the three
 * lines into apps/backend/.dev.vars. For production, set VAPID_PUBLIC_KEY and
 * VAPID_SUBJECT in wrangler.jsonc vars and `wrangler secret put
 * VAPID_PRIVATE_KEY` (docs/deploy.md).
 */

const pair = (await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;

function base64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const publicKey = (await crypto.subtle.exportKey(
  "raw",
  pair.publicKey,
)) as ArrayBuffer;
const privateKey = (await crypto.subtle.exportKey(
  "pkcs8",
  pair.privateKey,
)) as ArrayBuffer;

console.log(`VAPID_PUBLIC_KEY=${base64Url(publicKey)}`);
console.log(`VAPID_PRIVATE_KEY=${base64Url(privateKey)}`);
console.log(`VAPID_SUBJECT=https://sales.rising.sh`);
