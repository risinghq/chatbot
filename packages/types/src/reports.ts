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
  /** Every open business, for the unpinned platform operator; null otherwise. */
  businesses: ReportBusiness[] | null;
};
