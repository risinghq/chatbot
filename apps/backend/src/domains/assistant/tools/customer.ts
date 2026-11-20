import { CustomerService } from "../../customers/index.ts";
import { answer, type Tool } from "./types.ts";

const getCustomer: Tool = {
  name: "get_customer",
  description:
    "What the business knows of the customer in this chat: name, document " +
    "and saved delivery addresses. Null for a new customer.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  run: async (ctx) => {
    const customer = await CustomerService.getByPhone(ctx.tenantId, ctx.phone);
    if (!customer) return answer({ customer: null });
    const addresses = await CustomerService.addresses(
      ctx.tenantId,
      customer.id,
    );
    return answer({
      customer: {
        name: customer.name,
        document_type: customer.document_type,
        document_number: customer.document_number,
        addresses: addresses.map((a) => ({
          line: a.line,
          district: a.district,
          city: a.city,
          reference: a.reference,
        })),
      },
    });
  },
};

export const customerTools = [getCustomer];
