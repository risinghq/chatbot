/// <reference types="bun" />

import { describe, it, expect } from "bun:test";
import "../../testing/svelte-ssr.ts";
import { render } from "svelte/server";
import type { HistoryEntry } from "@vendeya/types";

const TENANT = "01a20963-f53c-759c-97bb-c737ff94f6cc";
const payload = "<img src=x onerror=alert(1)>";
const attributePayload = `x" onmouseover="alert(1)`;

function entry(fields: Partial<HistoryEntry>): HistoryEntry {
  return {
    id: crypto.randomUUID(),
    at: 1_700_018_000_000,
    actor: { kind: "user", userId: "u1", name: "Ana" },
    action: "create_customer",
    subject: { type: "customer", id: "c1", label: "Rosa" },
    details: {},
    ...fields,
  };
}

async function show(entries: HistoryEntry[], now = 1_700_018_000_000) {
  const { default: List } = await import("./history-list.svelte");
  return render(List, { props: { entries, place: { tenantId: TENANT }, now } })
    .body;
}

describe("the history list", () => {
  /**
   * 03:13 UTC on the 15th is still the evening of the 14th in Lima, so a list
   * that formats in the machine's zone shows another time and another day.
   */
  it("shows the time in es-PE and America/Lima, under the Lima day", async () => {
    const body = await show([entry({})], 1_700_300_000_000);

    expect(body).toContain("10:13:20");
    expect(body).toContain("Martes, 14 de noviembre de 2023");
  });

  it("titles today's entries Hoy", async () => {
    expect(await show([entry({})])).toContain("Hoy");
  });

  it("says who did what to which record, linking the record's page", async () => {
    const body = await show([entry({})]);

    expect(body).toContain("Ana");
    expect(body).toContain("agregó al cliente");
    expect(body).toContain(`href="/dashboard/${TENANT}/clientes/c1"`);
    expect(body).not.toContain("create_customer");
  });

  it("does not link a deleted record", async () => {
    const body = await show([entry({ action: "delete_customer" })]);

    expect(body).toContain("borró al cliente");
    expect(body).not.toContain("clientes/c1");
  });

  it("shows a stored value as text, in the sentence and in an attribute", async () => {
    const body = await show([
      entry({
        actor: { kind: "user", userId: "u1", name: payload },
        action: "send_message",
        subject: { type: "conversation", id: attributePayload, label: payload },
        details: { message: payload },
      }),
    ]);

    expect(body).toContain("&lt;img");
    expect(body).not.toContain("<img");
    expect(body).not.toContain(` onmouseover="alert(1)"`);
  });
});
