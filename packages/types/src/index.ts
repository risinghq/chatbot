import type { StoredMessageType } from "./whatsapp.ts";

export type UserRole = "admin" | "developer" | "supervisor" | "sales_agent";

// Tenancy
/** Role a user holds inside one tenant. Platform operators hold none. */
export type TenantRole = UserRole;
export type TenantStatus = "active" | "suspended";

export type Tenant = {
  id: string;
  name: string;
  status: TenantStatus;
  created_at: number;
  updated_at: number;
};

export type TenantMembership = {
  id: string;
  tenant_id: string;
  user_id: string;
  role: TenantRole;
  /** Whether the agent takes new conversations *in this tenant*. */
  is_available: number;
  created_at: number;
  created_by: string | null;
};

// Channel accounts
/** Each business has one `simulator` channel, where the dashboard's simulator talks. */
export type ChannelType = "whatsapp" | "simulator";
export type ChannelAccountStatus = "active" | "pending" | "disabled";

export type ChannelAccount = {
  id: string;
  tenant_id: string;
  channel_type: ChannelType;
  waba_id: string | null;
  phone_number_id: string;
  display_phone_number: string | null;
  label: string | null;
  access_token_secret_id: string | null;
  verify_token_secret_id: string | null;
  app_secret_secret_id: string | null;
  status: ChannelAccountStatus;
  created_at: number;
  updated_at: number;
};

/**
 * Identity of one conversation: which business, which of its numbers, and the
 * contact on the other end. The same contact phone number reaching two tenants
 * is two distinct conversations.
 */
export type ConversationRef = {
  tenantId: string;
  channelAccountId: string;
  phoneNumber: string;
};

// Assets
export type AssetKind = "catalog_image" | "contract" | "recording";
export type AssetVisibility = "public" | "private";

export type Asset = {
  id: string;
  tenant_id: string;
  kind: AssetKind;
  visibility: AssetVisibility;
  storage_key: string;
  content_type: string | null;
  byte_size: number | null;
  created_by: string | null;
  created_at: number;
};

// Catalog types
export type {
  Product,
  ProductStatus,
  ProductVariant,
  ProductImage,
} from "./catalog.ts";
export type {
  StockLocation,
  StockMovement,
  StockMovementKind,
  StockRow,
} from "./stock.ts";
export { STOCK_MOVEMENT_KINDS } from "./stock.ts";
export { parseCents } from "./money.ts";
export type {
  Customer,
  CustomerAddress,
  CustomerSummary,
  DeliveryZone,
  DocumentType,
  Order,
  OrderDetail,
  OrderLine,
  OrderMetrics,
  OrderSource,
  OrderStatus,
  OrderSummary,
  Payment,
  PaymentMethod,
  PaymentState,
  PaymentStatus,
  Shipment,
  ShipmentSummary,
} from "./orders.ts";
export {
  DOCUMENT_TYPES,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  paymentState,
} from "./orders.ts";
export { MIN_PASSWORD_LENGTH } from "./accounts.ts";
export type { AssistantModel, AssistantSettings } from "./assistant.ts";
export {
  ASSISTANT_MODELS,
  ASSISTANT_TEXT_LIMIT,
  MODEL_PRICES,
} from "./assistant.ts";
export type {
  ReportBusiness,
  ReportDay,
  ReportProduct,
  ReportSummary,
} from "./reports.ts";
export {
  isTenantSecretSettingKey,
  TENANT_SECRET_SETTING_KEYS,
} from "./settings.ts";

export const CONVERSATION_STATUSES = [
  "active",
  "human_takeover",
  "closed",
] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

/**
 * A conversation as the API returns it. `customer_name` is the name of the
 * business's customer with the conversation's phone number, if there is one.
 */
export type Conversation = {
  tenant_id: string;
  channel_account_id: string;
  phone_number: string;
  status: ConversationStatus;
  handover_reason: string | null;
  is_simulation: number;
  last_activity_at: number;
  assigned_agent: string | null;
  assignment_notified_at: number | null;
  customer_name: string | null;
};

export type ConversationMessage = {
  id: string;
  tenant_id: string;
  channel_account_id: string;
  phone_number: string;
  direction: "inbound" | "outbound";
  type: StoredMessageType;
  content: string;
  status: string;
  product_id: string | null;
  created_at: number;
};

export type User = {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  phone_number: string | null;
  is_platform_operator: number;
  is_active: number;
  created_at: number;
  created_by: string | null;
};

/**
 * The thing a history entry acted on, named as people know it: an order by its
 * number, a customer or product by its name. `label` is null when the row is
 * gone and the entry did not record a name. A variant or stock movement is
 * reported as its product, so the entry links to a page that exists.
 */
export type HistorySubject = {
  type: string;
  id: string;
  label: string | null;
};

/** Who took a history entry's action: a person, or a terminal command. */
export type HistoryActor =
  | { kind: "user"; userId: string; name: string | null }
  | { kind: "terminal"; name: string };

/** One audit row, as the Historial pages read it. */
export type HistoryEntry = {
  id: string;
  at: number;
  actor: HistoryActor;
  action: string;
  subject: HistorySubject | null;
  /** The row's recorded metadata. Secrets are recorded as `<stored>`. */
  details: Record<string, unknown>;
};

/** One call the assistant made to the model, for the Asistente's Registro. */
export type AssistantCall = {
  id: string;
  created_at: number;
  operation: string;
  model: string;
  phone_number: string;
  /** The business's customer with this phone, if there is one. */
  customer_name: string | null;
  status: "success" | "error";
  latency_ms: number | null;
  tokens_total: number | null;
  prompt: string;
  response: string | null;
  error_message: string | null;
};

export type ProviderCheckResult = {
  eligible: boolean;
  credit: number;
  name?: string;
  nse?: number;
  reason?: string;
};

/**
 * What a Cálidda credit check found for one DNI. `source` is the provider that
 * answered: FNB through the business's Cálidda login, or the Power BI report
 * behind GASO, which also reports the NSE.
 */
export type CreditCheck =
  | {
      status: "eligible";
      source: "fnb" | "powerbi";
      credit: number;
      name?: string;
      nse?: number;
    }
  | { status: "not_eligible" }
  | { status: "system_outage" };

export type ReplayMetadata = {
  conversationId: string;
  customerName: string | null;
  messageCount: number;
  timestamp: string;
};

export type ReplayData = {
  conversation: Conversation;
  messages: ConversationMessage[];
  metadata: ReplayMetadata;
};

// WhatsApp message types
export type {
  StoredMessageType,
  InboundMessageType,
  QuotedMessageContext,
  IncomingMessage,
} from "./whatsapp.ts";

export * from "./events.ts";
