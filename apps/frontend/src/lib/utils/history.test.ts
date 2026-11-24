/// <reference types="bun" />

import { describe, it, expect } from "bun:test";
import type { HistoryEntry } from "@vendeya/types";
import { byDay, phrase } from "./history.ts";

const TENANT = "t1";
const place = { tenantId: TENANT };

function entry(fields: Partial<HistoryEntry>): HistoryEntry {
  return {
    id: crypto.randomUUID(),
    at: 0,
    actor: { kind: "user", userId: "u1", name: "Ana" },
    action: "create_customer",
    subject: null,
    details: {},
    ...fields,
  };
}

const sentence = (
  e: HistoryEntry,
  where: Parameters<typeof phrase>[1] = place,
) => {
  const p = phrase(e, where);
  return [p.actor, p.verb, p.subject?.label, p.tail].filter(Boolean).join(" ");
};

describe("a history sentence", () => {
  it("names a revoked token, or says a token when nothing named it", () => {
    const revoke = (label: string | null) =>
      sentence(
        entry({
          action: "revoke_api_token",
          subject: { type: "api_token", id: "k", label },
        }),
      );
    expect(revoke("ci")).toBe("Ana revocó el token de API ci");
    expect(revoke(null)).toBe("Ana revocó un token de API");
  });

  it("names a terminal command's operator and a nameless user", () => {
    expect(
      phrase(entry({ actor: { kind: "terminal", name: "dubu" } }), place).actor,
    ).toBe("dubu (terminal)");
    expect(
      phrase(entry({ actor: { kind: "user", userId: "u", name: null } }), place)
        .actor,
    ).toBe("Un usuario sin nombre");
  });

  it("reads an order's status, amount and number from the entry", () => {
    const order = { type: "order", id: "o1", label: "#1001" };

    expect(
      sentence(
        entry({
          action: "transition_order",
          subject: order,
          details: { status: "confirmed" },
        }),
      ),
    ).toBe("Ana pasó el pedido #1001 a confirmado");
    expect(
      sentence(
        entry({
          action: "add_payment",
          subject: order,
          details: { amount_cents: 12_550 },
        }),
      ),
    ).toBe("Ana registró un pago de S/ 125.50 en el pedido #1001");
  });

  it("reads a role and a stock movement in words", () => {
    const user = { type: "user", id: "u2", label: "Luis" };
    const product = { type: "product", id: "p1", label: "Taladro" };

    expect(
      sentence(
        entry({
          action: "update_user_role",
          subject: user,
          details: { newRole: "supervisor" },
        }),
      ),
    ).toBe("Ana cambió el rol de Luis a supervisor");
    expect(
      sentence(
        entry({
          action: "record_stock_movement",
          subject: product,
          details: { kind: "ship", quantity: -3 },
        }),
      ),
    ).toBe("Ana despachó 3 unidades de Taladro");
  });

  it("names a gone record that recorded no name by its kind", () => {
    expect(
      sentence(
        entry({
          action: "delete_customer",
          subject: { type: "customer", id: "c", label: null },
        }),
      ),
    ).toBe("Ana borró al cliente un cliente");
  });

  it("links a business only, on the platform", () => {
    const user = entry({
      action: "create_user",
      subject: { type: "user", id: "u2", label: "Luis" },
    });
    const tenant = entry({
      action: "create_tenant",
      subject: { type: "tenant", id: "t9", label: "Ferretería" },
    });

    expect(phrase(user, { platform: true }).subject?.href).toBeNull();
    expect(phrase(tenant, { platform: true }).subject?.href).toBe(
      "/dashboard/t9",
    );
  });

  it("marks a message WhatsApp did not confirm, and quotes it", () => {
    const p = phrase(
      entry({
        action: "send_message",
        subject: { type: "conversation", id: "51900000001", label: "Rosa" },
        details: { message: "Hola", deliveryUnconfirmed: true },
      }),
      place,
    );

    expect(p.unconfirmed).toBe(true);
    expect(p.quote).toBe("Hola");
    expect(p.subject?.href).toBe(
      `/dashboard/${TENANT}/conversations/51900000001`,
    );
  });

  it("never shows an unknown action's code with underscores", () => {
    expect(phrase(entry({ action: "do_a_thing" }), place).verb).toBe(
      "hizo «do a thing» en",
    );
  });
});

describe("the history's days", () => {
  const NOW = Date.UTC(2026, 10, 24, 15); // 10:00 in Lima

  it("groups by Lima day and titles today and yesterday", () => {
    const days = byDay(
      [
        entry({ at: NOW }),
        entry({ at: Date.UTC(2026, 10, 24, 4) }), // 23:00 on the 23rd in Lima
        entry({ at: Date.UTC(2026, 10, 20, 15) }),
      ],
      NOW,
    );

    expect(days.map((d) => [d.title, d.entries.length])).toEqual([
      ["Hoy", 1],
      ["Ayer", 1],
      ["Viernes, 20 de noviembre de 2026", 1],
    ]);
  });
});
