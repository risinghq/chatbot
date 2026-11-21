import { newId } from "@vendeya/utils";
import type { ConversationStatus } from "@vendeya/types";
import { batch, getOne, stmt } from "../index.ts";

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
  const exists = await getOne(
    "SELECT 1 FROM conversations WHERE tenant_id = ? LIMIT 1",
    [tenantId],
  );
  if (exists) return;

  const now = Date.now();
  const statements: D1PreparedStatement[] = [];

  // The fixture names an agent by id. The seeds create no user accounts, so
  // link the agent only when that user exists.
  const agentExists = async (id: string): Promise<boolean> =>
    Boolean(await getOne("SELECT 1 FROM users WHERE id = ?", [id]));

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
      stmt(
        `INSERT INTO customers (id, tenant_id, name, phone, document_type, document_number)
         VALUES (?, ?, ?, ?, 'dni', ?)`,
        [
          newId(),
          tenantId,
          conversation.clientName,
          conversation.phoneNumber,
          conversation.dni,
        ],
      ),
      stmt(
        `INSERT INTO conversations (
          tenant_id, channel_account_id, phone_number, status, assigned_agent,
          assignment_notified_at, is_simulation, last_activity_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tenantId,
          channelAccountId,
          conversation.phoneNumber,
          conversation.status,
          assignedAgent,
          assignmentNotifiedAt,
          0,
          lastActivityAt,
        ],
      ),
    );

    for (const message of conversation.messages) {
      const messageId = newId();
      const direction = message.role === "incoming" ? "inbound" : "outbound";
      const createdAt = now + message.offsetMs;

      statements.push(
        stmt(
          `INSERT INTO messages (
            id, tenant_id, channel_account_id, phone_number, direction, type, content, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            messageId,
            tenantId,
            channelAccountId,
            conversation.phoneNumber,
            direction,
            "text",
            message.text,
            createdAt,
          ],
        ),
      );
    }
  }

  await batch(statements);
}
