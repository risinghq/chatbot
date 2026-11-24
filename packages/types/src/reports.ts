/** One Lima calendar day of a report. */
export type ReportDay = {
  date: string;
  contacts: number;
  orders: number;
  revenueCents: number;
};

export type ReportProduct = {
  name: string;
  quantity: number;
  revenueCents: number;
};

/** Sales one click-to-WhatsApp ad brought in over the report's range. */
export type ReportAd = {
  /** Meta's ad id; the row's key. */
  sourceId: string;
  /** The ad's headline; null when Meta sent none, so the id stands in. */
  headline: string | null;
  /** Conversations the ad opened in the range. */
  conversations: number;
  /** Non-cancelled orders the ad is credited with in the range. */
  orders: number;
  /** Confirmed payments of those orders. */
  paidCents: number;
};

/** One business's line in the operator's cross-business report. */
export type ReportBusiness = {
  tenantId: string;
  name: string;
  contacts: number;
  orders: number;
  revenueCents: number;
  aiCalls: number;
  aiErrors: number;
  aiCostUsd: number;
  /** A key is stored; without one the assistant hands every turn off. */
  hasOpenAiKey: boolean;
};

/**
 * Sales over a range of Lima days. A contact is a conversation the customer
 * wrote to in the range; simulations are left out. Orders and revenue leave
 * out cancelled orders. AI calls include the simulator's, since they spend
 * the business's OpenAI key.
 */
export type ReportSummary = {
  startDate: string;
  endDate: string;
  contacts: number;
  orders: {
    count: number;
    cancelled: number;
    revenueCents: number;
    averageCents: number;
    fromAssistant: number;
    assistantRevenueCents: number;
    /** Customers with at least one order in the range. */
    buyers: number;
  };
  ai: {
    calls: number;
    errors: number;
    tokensPrompt: number;
    tokensCompletion: number;
    /** Estimated from list prices (MODEL_PRICES). */
    costUsd: number;
    /** Calls on a model with no known price, left out of `costUsd`. */
    unpricedCalls: number;
  };
  days: ReportDay[];
  topProducts: ReportProduct[];
  /** Click-to-WhatsApp ads with a conversation or order in the range. */
  ads: ReportAd[];
  /** Every open business, for the unpinned platform operator; null otherwise. */
  businesses: ReportBusiness[] | null;
};
