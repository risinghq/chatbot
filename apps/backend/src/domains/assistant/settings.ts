import {
  ASSISTANT_MODELS,
  ASSISTANT_TEXT_LIMIT,
  type AssistantModel,
  type AssistantSettings,
} from "@vendeya/types";
import { db } from "../../db/index.ts";
import { StockService } from "../stock/index.ts";

type Fields = Omit<AssistantSettings, "updated_at">;

const TEXT_FIELDS = ["instructions", "faq", "policies"] as const;

/** What a business that never saved its settings runs on. */
export function defaultAssistantSettings(): AssistantSettings {
  return {
    instructions: "",
    faq: "",
    policies: "",
    model: ASSISTANT_MODELS[0],
    stock_location_id: null,
    updated_at: null,
  };
}

function isModel(value: unknown): value is AssistantModel {
  return ASSISTANT_MODELS.includes(value as AssistantModel);
}

/** The fields an update sets, or the reason the body is refused. */
export function parseAssistantFields(
  body: Record<string, unknown>,
): Partial<Fields> | string {
  const fields: Partial<Fields> = {};
  for (const key of TEXT_FIELDS) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "string") return `${key} must be a string`;
    if (value.length > ASSISTANT_TEXT_LIMIT) {
      return `${key} is longer than ${ASSISTANT_TEXT_LIMIT} characters`;
    }
    fields[key] = value.trim();
  }
  if (body.model !== undefined) {
    if (!isModel(body.model)) {
      return `model must be one of ${ASSISTANT_MODELS.join(", ")}`;
    }
    fields.model = body.model;
  }
  if (body.stock_location_id !== undefined) {
    const id = body.stock_location_id;
    if (id !== null && (typeof id !== "string" || id === "")) {
      return "stock_location_id must be a location id or null";
    }
    fields.stock_location_id = id;
  }
  return fields;
}

/** The location named does not belong to the business. */
export class UnknownLocationError extends Error {
  constructor() {
    super("stock location not found");
  }
}

export const AssistantSettingsService = {
  get: async (tenantId: string): Promise<AssistantSettings> => {
    const row = await db
      .selectFrom("assistant_settings")
      .select([
        "instructions",
        "faq",
        "policies",
        "model",
        "stock_location_id",
        "updated_at",
      ])
      .where("tenant_id", "=", tenantId)
      .executeTakeFirst();
    if (!row) return defaultAssistantSettings();
    // A model dropped from the list falls back to the default.
    return {
      ...row,
      model: isModel(row.model) ? row.model : ASSISTANT_MODELS[0],
    };
  },

  /** Saves the fields given over the stored ones. Throws `UnknownLocationError`. */
  update: async (
    tenantId: string,
    fields: Partial<Fields>,
    userId: string | null,
  ): Promise<AssistantSettings> => {
    if (fields.stock_location_id) {
      const location = await StockService.getLocation(
        tenantId,
        fields.stock_location_id,
      );
      if (!location) throw new UnknownLocationError();
    }
    const next = {
      ...(await AssistantSettingsService.get(tenantId)),
      ...fields,
    };
    const values = {
      instructions: next.instructions,
      faq: next.faq,
      policies: next.policies,
      model: next.model,
      stock_location_id: next.stock_location_id,
      updated_by: userId,
      updated_at: Date.now(),
    };
    await db
      .insertInto("assistant_settings")
      .values({ tenant_id: tenantId, ...values })
      .onConflict((oc) => oc.column("tenant_id").doUpdateSet(values))
      .execute();
    return AssistantSettingsService.get(tenantId);
  },
};
