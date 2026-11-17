import { tenantPredicate } from "../../db/query.ts";
import type { Asset, AssetKind, AssetVisibility } from "@vendeya/types";
import { getAll, getOne, run } from "../../db/index.ts";

export const AssetService = {
  create: async (data: {
    tenantId: string;
    kind: AssetKind;
    visibility: AssetVisibility;
    storageKey: string;
    contentType?: string | null;
    byteSize?: number | null;
    createdBy?: string | null;
    id?: string;
  }): Promise<Asset> => {
    const id = data.id ?? crypto.randomUUID();

    await run(
      `INSERT INTO assets (id, tenant_id, kind, visibility, storage_key, content_type, byte_size, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        data.tenantId,
        data.kind,
        data.visibility,
        data.storageKey,
        data.contentType ?? null,
        data.byteSize ?? null,
        data.createdBy ?? null,
      ],
    );

    return (await AssetService.getById(data.tenantId, id))!;
  },

  /**
   * A null `tenantId` reads across open tenants. Pass it only when the caller
   * checks tenant access itself, as GET /api/assets/:id does.
   */
  getById: async (tenantId: string | null, id: string): Promise<Asset | null> =>
    (await getOne<Asset>(
      `SELECT * FROM assets WHERE id = ? AND ${tenantPredicate(tenantId)}`,
      tenantId ? [id, tenantId] : [id],
    )) ?? null,

  getByStorageKey: async (
    tenantId: string | null,
    storageKey: string,
  ): Promise<Asset | null> =>
    (await getOne<Asset>(
      `SELECT * FROM assets WHERE storage_key = ? AND ${tenantPredicate(tenantId)}`,
      tenantId ? [storageKey, tenantId] : [storageKey],
    )) ?? null,

  listForTenant: async (tenantId: string, kind?: AssetKind): Promise<Asset[]> =>
    await getAll<Asset>(
      `SELECT * FROM assets WHERE tenant_id = ? ${kind ? "AND kind = ?" : ""}
       ORDER BY created_at DESC`,
      kind ? [tenantId, kind] : [tenantId],
    ),

  deleteById: async (tenantId: string, id: string): Promise<void> => {
    await run("DELETE FROM assets WHERE id = ? AND tenant_id = ?", [
      id,
      tenantId,
    ]);
  },

  deleteByStorageKey: async (
    tenantId: string,
    storageKey: string,
  ): Promise<void> => {
    await run("DELETE FROM assets WHERE storage_key = ? AND tenant_id = ?", [
      storageKey,
      tenantId,
    ]);
  },
};
