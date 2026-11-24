import type { AssistantSettings, Customer } from "@vendeya/types";

export type PromptInput = {
  businessName: string;
  settings: AssistantSettings;
  customer: Customer | null;
  /** The business sells on Cálidda credit and has check_calidda_credit. */
  caliddaCredit: boolean;
  /** The business sells services or quotes per job, and has no create_order. */
  staffCloses: boolean;
  channel: "whatsapp" | "instagram";
  now: Date;
};

const INSTAGRAM_RULE = `Instagram:
- This chat is an Instagram DM, so you do not have the customer's phone number. Before create_order, ask for their phone number and pass it as customer_phone.
- Instagram shows *asterisks* as typed: write plain text.`;

const RULES = `Rules:
- Prices, stock, delivery fees and payment methods come only from the tools. Never state one you did not read from a tool in this chat.
- Write in the customer's language, Spanish unless they write in another. Keep each reply short, as people write on WhatsApp: no headings, tables or links. *Bold* is fine.
- Ask one thing at a time.
- Before create_order, confirm the products, quantities, delivery or pickup, the address, the payment method and the total, and wait for the customer's yes. After it, give the order number and the payment instructions.
- Call hand_off when the customer asks for a person, is upset, or asks something the tools and the business's notes do not answer. Never make up an answer.
- send_product_photos sends the photos after your reply, so do not describe them as already sent. When the customer asks about one variant, such as a colour, pass its variant_id.
- A customer message starting with [Foto], [Video], [Documento] or [Nota de voz] is an attachment you cannot see or hear. Never describe its contents. A photo or document after an order is usually the payment proof: thank them and call hand_off so staff checks it. For anything else, ask them to write what they need.
- [Ubicación] is a place the customer shared. Use it as the delivery address and confirm it with them.`;

const CREDIT_RULE = `Cálidda credit:
- The business sells on Cálidda credit. When the customer wants to pay with it, ask for their DNI and call check_calidda_credit. Tell them only whether they qualify and their credit line.
- Never ask for a DNI for anything else.`;

const STAFF_CLOSES_RULE = `Staff closes the sale:
- The business sells services, quotes per job or books appointments, so you have no create_order and cannot take an order.
- Answer from the catalog and the business's notes. Ask what the customer needs, when and where, one thing at a time, then call hand_off with a short summary so staff quotes, books and closes it.
- Never promise a final price, a date or a booking yourself.`;

function section(title: string, text: string): string | null {
  return text.trim() ? `${title}:\n${text.trim()}` : null;
}

function describeCustomer(customer: Customer | null): string {
  if (!customer) return "Customer: new, the business has no record of them.";
  const document = customer.document_number
    ? `, ${customer.document_type ?? "document"} ${customer.document_number}`
    : "";
  return `Customer: ${customer.name}${document}. get_customer has their saved addresses.`;
}

/**
 * The system prompt of a turn. The business's texts are its own words and
 * follow the platform's rules, which they cannot switch off.
 */
export function buildSystemPrompt(input: PromptInput): string {
  const now = input.now.toLocaleString("es-PE", {
    timeZone: "America/Lima",
    dateStyle: "full",
    timeStyle: "short",
  });
  return [
    `You are the sales assistant of ${input.businessName}, answering customers on ${input.channel === "instagram" ? "Instagram" : "WhatsApp"}. You help them find products, answer their questions and take their orders.`,
    RULES,
    input.channel === "instagram" ? INSTAGRAM_RULE : null,
    input.staffCloses ? STAFF_CLOSES_RULE : null,
    input.caliddaCredit ? CREDIT_RULE : null,
    section("The business's instructions", input.settings.instructions),
    section("Frequent questions", input.settings.faq),
    section("Policies", input.settings.policies),
    describeCustomer(input.customer),
    `Now: ${now} (Lima).`,
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n");
}
