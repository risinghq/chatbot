/**
 * Storage for files that are never served publicly: signed contracts and call
 * recordings. Their keys come from `privateStorageKey`, which `/media` refuses,
 * so the bytes are reachable only through /api/assets/:id, which checks tenant
 * scope first.
 */

import { env } from "cloudflare:workers";

export const privateFileStorage = {
  async write(storageKey: string, data: Uint8Array): Promise<void> {
    await env.FILES.put(storageKey, data);
  },

  /** The object body for streaming a response, or null when it is missing. */
  async read(storageKey: string): Promise<ReadableStream | null> {
    return (await env.FILES.get(storageKey))?.body ?? null;
  },

  async delete(storageKey: string): Promise<void> {
    await env.FILES.delete(storageKey);
  },
};
