import { eligibilityHandler } from "../../eligibility/index.ts";
import { text } from "./args.ts";
import { ToolArgumentError, answer, type Tool } from "./types.ts";

/**
 * The answer leaves out the name and NSE the providers return: whoever types
 * a DNI in the chat would otherwise learn a stranger's name.
 */
const checkCaliddaCredit: Tool = {
  name: "check_calidda_credit",
  description:
    "Whether the person with this DNI can pay with Cálidda credit, and their " +
    "credit line. Only for a customer who wants to pay with Cálidda credit.",
  parameters: {
    type: "object",
    properties: {
      dni: { type: "string", description: "The customer's DNI, 8 digits." },
    },
    required: ["dni"],
    additionalProperties: false,
  },
  run: async (ctx, args) => {
    const dni = text(args, "dni").replace(/\s/g, "");
    if (!/^\d{8}$/.test(dni)) {
      throw new ToolArgumentError("dni must be 8 digits");
    }
    const result = await eligibilityHandler.execute(dni, {
      tenantId: ctx.tenantId,
      channelAccountId: ctx.channelAccountId,
      phoneNumber: ctx.phone,
    });
    if (!result.ok || result.value.status === "system_outage") {
      return answer({
        status: "unavailable",
        note: "Cálidda cannot be checked now. Offer another payment method or a person.",
      });
    }
    const check = result.value;
    if (check.status === "not_eligible") {
      return answer({ status: "not_eligible" });
    }
    return answer({
      status: "eligible",
      credit_line: `S/ ${check.credit.toFixed(2)}`,
    });
  },
};

/** Offered only to a business with a Cálidda login. */
export const creditTools = [checkCaliddaCredit];
