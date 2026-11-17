import { PersonasService } from "../../domains/personas/index.ts";
import type { ConversationRef } from "@vendeya/types";
import { getOne } from "../../db/index.ts";

type ConversationRow = {
  is_simulation: number;
  persona_id: string | null;
};

export async function getSimulationPersona(ref: ConversationRef) {
  const conv = await getOne<ConversationRow>(
    `SELECT is_simulation, persona_id FROM conversations
     WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
    [ref.tenantId, ref.channelAccountId, ref.phoneNumber],
  );

  if (conv?.is_simulation === 1 && conv.persona_id) {
    return await PersonasService.getById(ref.tenantId, conv.persona_id);
  }
  return null;
}
