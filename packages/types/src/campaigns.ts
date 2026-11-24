export type TemplateCategory = "marketing" | "utility";

export const TEMPLATE_CATEGORIES: TemplateCategory[] = ["marketing", "utility"];

/**
 * The languages Meta accepts for a template. `es` covers a business that never
 * picked a variant.
 */
export const TEMPLATE_LANGUAGES = [
  "es",
  "es_MX",
  "es_AR",
  "es_CO",
  "es_ES",
  "en_US",
] as const;
export type TemplateLanguage = (typeof TEMPLATE_LANGUAGES)[number];

export type TemplateStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "paused"
  | "disabled";

/** Fields a `{{n}}` parameter can bind to, resolved per recipient. */
export const PARAM_FIELDS = [
  "customer_name",
  "order_number",
  "order_total",
  "pay_link",
] as const;
export type ParamField = (typeof PARAM_FIELDS)[number];

export type ParamBinding =
  | { kind: "field"; field: ParamField }
  | { kind: "text"; text: string };

export type MessageTemplate = {
  id: string;
  tenant_id: string;
  name: string;
  language: string;
  category: TemplateCategory;
  /** Body with `{{1}}`-style placeholders. */
  body: string;
  /** One binding per placeholder, as JSON. */
  params: ParamBinding[];
  status: TemplateStatus;
  meta_template_id: string | null;
  rejection_reason: string | null;
  created_at: number;
  updated_at: number;
};

/** Who a campaign goes out to. */
export type Audience =
  | { kind: "all" }
  | { kind: "category"; category: string }
  | { kind: "product"; product_id: string }
  | { kind: "inactive"; days: number }
  | { kind: "phones"; phones: string[] };

export const AUDIENCE_KINDS = [
  "all",
  "category",
  "product",
  "inactive",
  "phones",
] as const;
export type AudienceKind = (typeof AUDIENCE_KINDS)[number];

export type CampaignStatus =
  | "scheduled"
  | "sending"
  | "sent"
  | "failed"
  | "cancelled";

export type Campaign = {
  id: string;
  tenant_id: string;
  name: string;
  template_id: string;
  template_name?: string;
  audience: Audience;
  params: ParamBinding[];
  status: CampaignStatus;
  scheduled_at: number | null;
  sent_at: number | null;
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
};

export type RecipientStatus =
  | "pending"
  | "queued"
  | "skipped"
  | "sent"
  | "delivered"
  | "read"
  | "failed";

export type CampaignResults = {
  targeted: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  skipped: number;
  replied: number;
  /** Orders the campaign's recipients filed within 7 days of the send. */
  orders: number;
  orders_total_cents: number;
};

export type CampaignSummary = Campaign & { results: CampaignResults };

export type ReminderSettings = {
  abandoned_cart: {
    enabled: boolean;
    hours: number;
    template_id: string | null;
  };
  inactive: { enabled: boolean; days: number; template_id: string | null };
  /** At most one marketing template per customer inside this window. */
  marketing_min_interval_days: number;
};

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  abandoned_cart: { enabled: false, hours: 4, template_id: null },
  inactive: { enabled: false, days: 45, template_id: null },
  marketing_min_interval_days: 7,
};
