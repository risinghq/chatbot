import type {
  MessageTemplate,
  ParamBinding,
  ParamField,
  TemplateCategory,
  TemplateStatus,
} from "@vendeya/types";
import { PARAM_FIELDS, TEMPLATE_LANGUAGES } from "@vendeya/types";
import { newId } from "@vendeya/utils";
import { createMessageTemplate } from "../../adapters/whatsapp/cloud-api.ts";
import { db, tenantScope } from "../../db/index.ts";
import { ChannelAccountService } from "../channels/accounts.ts";

/** Meta names a template in lower snake case only. */
const NAME_PATTERN = /^[a-z0-9_]{1,512}$/;
const PARAM_PATTERN = /\{\{(\d+)\}\}/g;

/** The `{{n}}` indexes the body uses, sorted. */
export function placeholders(body: string): number[] {
  const found = new Set<number>();
  for (const match of body.matchAll(PARAM_PATTERN)) {
    found.add(Number(match[1]));
  }
  return [...found].sort((a, b) => a - b);
}

/** The field and literal values a `{{n}}` binding may hold, or the refusal. */
export function parseParams(
  value: unknown,
  body: string,
): ParamBinding[] | string {
  const needed = placeholders(body);
  const params = Array.isArray(value) ? value : [];
  if (needed.length !== params.length) {
    return `body uses {{${needed.join("}}, {{")}}}; params must bind each`;
  }
  const bindings: ParamBinding[] = [];
  for (const [i, raw] of params.entries()) {
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (!trimmed) return `params[${i}] must not be empty`;
      bindings.push({ kind: "text", text: trimmed });
    } else if (
      typeof raw === "object" &&
      raw !== null &&
      (PARAM_FIELDS as readonly unknown[]).includes(
        (raw as { field?: unknown }).field,
      )
    ) {
      bindings.push({
        kind: "field",
        field: (raw as { field: ParamField }).field,
      });
    } else {
      return `params[${i}] must be text or {field: one of ${PARAM_FIELDS.join(", ")}}`;
    }
  }
  return bindings;
}

export function parseTemplateFields(body: Record<string, unknown>):
  | {
      name: string;
      language: string;
      category: TemplateCategory;
      body: string;
      params: ParamBinding[];
    }
  | string {
  const { name, language, category, body: text } = body;
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    return "name must be lower snake case (a-z, 0-9 and _)";
  }
  if (
    typeof language !== "string" ||
    !(TEMPLATE_LANGUAGES as readonly string[]).includes(language)
  ) {
    return `language must be one of ${TEMPLATE_LANGUAGES.join(", ")}`;
  }
  if (category !== "marketing" && category !== "utility") {
    return "category must be marketing or utility";
  }
  if (typeof text !== "string" || text.trim() === "") {
    return "body must be a non-empty string";
  }
  if (placeholders(text).length === 0) {
    return "body needs at least one {{n}} parameter";
  }
  const params = parseParams(body.params, text);
  if (typeof params === "string") return params;
  return {
    name,
    language,
    category,
    body: text.trim(),
    params,
  };
}

const STATUSES: TemplateStatus[] = [
  "pending",
  "approved",
  "rejected",
  "paused",
  "disabled",
];

function rowToTemplate(row: Record<string, unknown>): MessageTemplate {
  return {
    ...row,
    params: JSON.parse((row.params as string) ?? "[]"),
  } as MessageTemplate;
}

export const TemplateService = {
  async list(tenantId: string): Promise<MessageTemplate[]> {
    const rows = await db
      .selectFrom("message_templates")
      .selectAll()
      .where(tenantScope(tenantId))
      .orderBy("created_at", "desc")
      .execute();
    return rows.map(rowToTemplate);
  },

  async get(tenantId: string, id: string): Promise<MessageTemplate | null> {
    const row = await db
      .selectFrom("message_templates")
      .selectAll()
      .where(tenantScope(tenantId))
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? rowToTemplate(row) : null;
  },

  /**
   * Stores the template and registers it with Meta. The Graph call needs an
   * active number with a WABA id and a token; `error` names why it was refused.
   */
  async create(
    tenantId: string,
    fields: {
      name: string;
      language: string;
      category: TemplateCategory;
      body: string;
      params: ParamBinding[];
    },
    userId: string | null,
  ): Promise<MessageTemplate | { error: string }> {
    const account = await ChannelAccountService.getDefaultForTenant(tenantId);
    if (!account) return { error: "no_channel_account" };
    const registered = await createMessageTemplate(account, {
      name: fields.name,
      language: fields.language,
      category: fields.category,
      body: fields.body,
    });
    if ("error" in registered) return { error: registered.error };

    const now = Date.now();
    const status = (STATUSES as string[]).includes(
      registered.status.toLowerCase(),
    )
      ? registered.status.toLowerCase()
      : "pending";
    const id = newId();
    await db
      .insertInto("message_templates")
      .values({
        id,
        tenant_id: tenantId,
        name: fields.name,
        language: fields.language,
        category: fields.category,
        body: fields.body,
        params: JSON.stringify(fields.params),
        status: status as TemplateStatus,
        meta_template_id: registered.id,
        created_by: userId,
        created_at: now,
        updated_at: now,
      })
      .execute();
    return (await TemplateService.get(tenantId, id))!;
  },

  /**
   * Applies a `message_template_status_update` webhook to the template it
   * names, inside the tenant the webhook's WABA belongs to.
   */
  async applyStatus(
    tenantId: string,
    metaTemplateId: string | null,
    templateName: string | null,
    event: string,
    reason: string | null,
  ): Promise<void> {
    const status = event.toLowerCase();
    if (!STATUSES.includes(status as TemplateStatus)) return;

    let query = db
      .updateTable("message_templates")
      .set({
        status: status as TemplateStatus,
        rejection_reason: reason,
        updated_at: Date.now(),
      })
      .where(tenantScope(tenantId));
    if (metaTemplateId) {
      query = query.where("meta_template_id", "=", metaTemplateId);
    } else if (templateName) {
      query = query.where("name", "=", templateName);
    } else {
      return;
    }
    await query.execute();
  },
};
