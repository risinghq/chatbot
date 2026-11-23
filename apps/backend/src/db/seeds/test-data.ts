import { newId } from "@vendeya/utils";
import type { ConversationStatus } from "@vendeya/types";
import type { Compilable } from "kysely";
import { batch, db } from "../index.ts";

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

type TestMessage = {
  role: "incoming" | "outgoing";
  text: string;
  offsetMs: number;
};

export type TestConversation = {
  phoneNumber: string;
  clientName: string;
  dni: string;
  status: ConversationStatus;
  messages: TestMessage[];
  assignedAgent?: string;
  assignmentNotifiedAt?: number;
};

export const TEST_CONVERSATIONS: TestConversation[] = [
  {
    phoneNumber: "+51999888777",
    clientName: "Juan Pérez",
    dni: "12345678",
    status: "active" as const,
    messages: [
      { role: "incoming" as const, text: "Hola", offsetMs: -60 * MINUTE_MS },
      {
        role: "outgoing" as const,
        text: "¡Qué tal! Somos Cálidda. ¿Tu servicio de gas está a tu nombre?",
        offsetMs: -58 * MINUTE_MS,
      },
      { role: "incoming" as const, text: "Sí", offsetMs: -50 * MINUTE_MS },
      {
        role: "outgoing" as const,
        text: "Genial 😊. Por favor, indícame tu DNI para verificar tus beneficios.",
        offsetMs: -48 * MINUTE_MS,
      },
      {
        role: "incoming" as const,
        text: "12345678",
        offsetMs: -40 * MINUTE_MS,
      },
      {
        role: "outgoing" as const,
        text: "Perfecto. Tienes una línea de crédito de S/ 5,000. Te puedo ofrecer productos financieros.",
        offsetMs: -35 * MINUTE_MS,
      },
    ],
  },
  {
    phoneNumber: "+51999888888",
    clientName: "Ana Torres",
    dni: "87654321",
    status: "closed" as const,
    assignedAgent: "agent-001",
    messages: [
      {
        role: "incoming" as const,
        text: "Buenos días",
        offsetMs: -2 * HOUR_MS,
      },
      {
        role: "outgoing" as const,
        text: "¡Hola! Somos Cálidda. ¿El servicio de gas está a tu nombre?",
        offsetMs: -2 * HOUR_MS + 2 * MINUTE_MS,
      },
      {
        role: "incoming" as const,
        text: "Sí es mío",
        offsetMs: -2 * HOUR_MS + 10 * MINUTE_MS,
      },
      {
        role: "outgoing" as const,
        text: "Perfecto. Indícame tu DNI para verificar tus beneficios.",
        offsetMs: -2 * HOUR_MS + 12 * MINUTE_MS,
      },
      {
        role: "incoming" as const,
        text: "87654321",
        offsetMs: -2 * HOUR_MS + 20 * MINUTE_MS,
      },
      {
        role: "outgoing" as const,
        text: "Tienes una línea de crédito de S/ 2,500! Te puedo mostrar equipos disponibles.",
        offsetMs: -2 * HOUR_MS + 25 * MINUTE_MS,
      },
    ],
  },
];

export async function seedTestData(tenantId: string, channelAccountId: string) {
  const exists = await db
    .selectFrom("conversations")
    .select("tenant_id")
    .where("tenant_id", "=", tenantId)
    .limit(1)
    .executeTakeFirst();
  if (exists) return;

  const now = Date.now();
  const statements: Compilable[] = [];

  // The fixture names an agent by id. The seeds create no user accounts, so
  // link the agent only when that user exists.
  const agentExists = async (id: string): Promise<boolean> =>
    Boolean(
      await db
        .selectFrom("users")
        .select("id")
        .where("id", "=", id)
        .executeTakeFirst(),
    );

  for (const conversation of TEST_CONVERSATIONS) {
    const lastActivityAt =
      now + conversation.messages[conversation.messages.length - 1]!.offsetMs;
    const assignmentNotifiedAt = conversation.assignmentNotifiedAt
      ? now + conversation.assignmentNotifiedAt
      : null;

    const assignedAgent =
      conversation.assignedAgent &&
      (await agentExists(conversation.assignedAgent))
        ? conversation.assignedAgent
        : null;

    statements.push(
      db.insertInto("customers").values({
        id: newId(),
        tenant_id: tenantId,
        name: conversation.clientName,
        phone: conversation.phoneNumber,
        document_type: "dni",
        document_number: conversation.dni,
      }),
      db.insertInto("conversations").values({
        tenant_id: tenantId,
        channel_account_id: channelAccountId,
        phone_number: conversation.phoneNumber,
        status: conversation.status,
        assigned_agent: assignedAgent,
        assignment_notified_at: assignmentNotifiedAt,
        is_simulation: 0,
        last_activity_at: lastActivityAt,
      }),
    );

    for (const message of conversation.messages) {
      const messageId = newId();
      const direction = message.role === "incoming" ? "inbound" : "outbound";
      const createdAt = now + message.offsetMs;

      statements.push(
        db.insertInto("messages").values({
          id: messageId,
          tenant_id: tenantId,
          channel_account_id: channelAccountId,
          phone_number: conversation.phoneNumber,
          direction,
          type: "text",
          content: message.text,
          created_at: createdAt,
        }),
      );
    }
  }

  await batch(statements);
}
