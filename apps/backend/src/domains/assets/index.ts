import { newId } from "@vendeya/utils";
import type { Asset, AssetKind, AssetVisibility } from "@vendeya/types";
import { db, tenantScope } from "../../db/index.ts";

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
    const id = data.id ?? newId();

    await db
      .insertInto("assets")
      .values({
        id,
        tenant_id: data.tenantId,
        kind: data.kind,
        visibility: data.visibility,
        storage_key: data.storageKey,
        content_type: data.contentType ?? null,
        byte_size: data.byteSize ?? null,
        created_by: data.createdBy ?? null,
      })
      .execute();

    return (await AssetService.getById(data.tenantId, id))!;
  },

  /**
   * A null `tenantId` reads across open tenants. Pass it only when the caller
   * checks tenant access itself, as GET /api/assets/:id does.
   */
  getById: async (tenantId: string | null, id: string): Promise<Asset | null> =>
    (await db
      .selectFrom("assets")
      .selectAll()
      .where("id", "=", id)
      .where(tenantScope(tenantId))
      .executeTakeFirst()) ?? null,

  getByStorageKey: async (
    tenantId: string | null,
    storageKey: string,
  ): Promise<Asset | null> =>
    (await db
      .selectFrom("assets")
      .selectAll()
      .where("storage_key", "=", storageKey)
      .where(tenantScope(tenantId))
      .executeTakeFirst()) ?? null,

  listForTenant: async (tenantId: string, kind?: AssetKind): Promise<Asset[]> =>
    await db
      .selectFrom("assets")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .$if(Boolean(kind), (q) => q.where("kind", "=", kind!))
      .orderBy("created_at", "desc")
      .execute(),

  deleteById: async (tenantId: string, id: string): Promise<void> => {
    await db
      .deleteFrom("assets")
      .where("id", "=", id)
      .where("tenant_id", "=", tenantId)
      .execute();
  },

  deleteByStorageKey: async (
    tenantId: string,
    storageKey: string,
  ): Promise<void> => {
    await db
      .deleteFrom("assets")
      .where("storage_key", "=", storageKey)
      .where("tenant_id", "=", tenantId)
      .execute();
  },
};
