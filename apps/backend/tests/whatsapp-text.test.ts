import { describe, expect, it } from "vitest";
import { toWhatsAppText } from "../src/domains/assistant/whatsapp-text.ts";

describe("toWhatsAppText", () => {
  it("turns Markdown bold, italic and strike into WhatsApp markup", () => {
    expect(
      toWhatsAppText("Cuesta **S/189.90**, __envío gratis__, ~~S/210~~"),
    ).toBe("Cuesta *S/189.90*, _envío gratis_, ~S/210~");
  });

  it("keeps WhatsApp markup as written", () => {
    const text = "Tenemos *Taladro 650 W* a _S/189.90_";
    expect(toWhatsAppText(text)).toBe(text);
  });

  it("turns a heading into a bold line", () => {
    expect(toWhatsAppText("## Resumen\nTotal S/50")).toBe(
      "*Resumen*\nTotal S/50",
    );
  });

  it("writes a link as its text and the URL", () => {
    expect(
      toWhatsAppText("Mira [el catálogo](https://example.com/c) aquí"),
    ).toBe("Mira el catálogo (https://example.com/c) aquí");
  });

  it("leaves a list's asterisks alone", () => {
    const text = "* Taladro\n* Martillo";
    expect(toWhatsAppText(text)).toBe(text);
  });
});
