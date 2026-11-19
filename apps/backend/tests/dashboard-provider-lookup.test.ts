/**
 * The Proveedores page renders what `GET /api/providers/:dni` answers. These
 * tests take a real response body, built by the eligibility mapper and the
 * route, and render it with the page's result card.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { run } from "../src/db/index.ts";

import { requireAuth } from "../src/middleware/auth.ts";
import { errorHandler } from "../src/middleware/error.ts";
import { eligibilityHandler } from "../src/bootstrap/index.ts";
import { mapEligibilityToEnrichment } from "../src/domains/eligibility/mapper.ts";
import { Err, Ok } from "../src/shared/result/index.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import providerRoutes from "../src/routes/providers.ts";
import { frontendPath, importFrontend } from "./helpers/frontend.ts";

const CARD_PATH = frontendPath("lib/components/providers/lookup-result.svelte");
const { renderComponent } = await importFrontend<{
  renderComponent: (
    path: string,
    props: Record<string, unknown>,
  ) => Promise<string>;
}>("lib/testing/render.ts");

const DNI = "12345678";

describe("the provider lookup page", () => {
  const app = new Hono();
  app.use("/api/*", requireAuth);
  app.route("/api/providers", providerRoutes);
  app.onError(errorHandler);

  let cookie: string;
  let execute: ReturnType<typeof vi.spyOn>;

  /** What the browser gets for a lookup, rendered the way the page shows it. */
  async function lookupPage(): Promise<string> {
    const response = await app.request(`/api/providers/${DNI}`, {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    const { result } = (await response.json()) as { result: unknown };
    return renderComponent(CARD_PATH, { result });
  }

  beforeEach(async () => {
    const userId = `u-${crypto.randomUUID()}`;
    await run(
      `INSERT INTO users (id, username, password_hash, role, name, is_platform_operator)
       VALUES (?, ?, 'x', 'admin', 'Operator', 1)`,
      [userId, `operator-${userId.slice(2, 10)}`],
    );
    const token = generateSessionToken();
    await createSession(token, userId, null);
    cookie = `session=${token}`;
    execute = vi.spyOn(eligibilityHandler, "execute");
  });

  afterEach(async () => {
    execute.mockRestore();
  });

  it("shows an FNB approval with the name and the credit line", async () => {
    execute.mockResolvedValue(
      Ok(
        await mapEligibilityToEnrichment(null, {
          eligible: true,
          credit: 1500,
          name: "Ana Pérez",
        }),
      ) as never,
    );

    const page = await lookupPage();

    expect(page).toContain(">Aprobado<");
    expect(page).not.toContain(">Rechazado<");
    expect(page).toContain("Ana Pérez");
    expect(page).toContain("S/ 1,500.00");
    expect(page).toContain("FNB");
    expect(page).not.toContain("Nivel NSE");
  });

  it("shows a GASO approval with its NSE", async () => {
    execute.mockResolvedValue(
      Ok(
        await mapEligibilityToEnrichment(null, {
          eligible: true,
          credit: 2500,
          name: "Luis Ríos",
          nse: 3,
        }),
      ) as never,
    );

    const page = await lookupPage();

    expect(page).toContain(">Aprobado<");
    expect(page).toContain("Gaso");
    expect(page).toContain("Nivel NSE");
  });

  it("shows a refusal without a credit line", async () => {
    execute.mockResolvedValue(
      Ok(
        await mapEligibilityToEnrichment(null, { eligible: false, credit: 0 }),
      ) as never,
    );

    const page = await lookupPage();

    expect(page).toContain(">Rechazado<");
    expect(page).not.toContain(">Aprobado<");
    expect(page).not.toContain("Línea aprobada");
    expect(page).not.toContain("NaN");
    expect(page).not.toContain("undefined");
  });

  it("says when no provider answered, not that the customer was refused", async () => {
    execute.mockResolvedValue(
      Ok(
        await mapEligibilityToEnrichment(null, {
          eligible: false,
          credit: 0,
          needsHuman: true,
          handoffReason: "both_providers_down",
        }),
      ) as never,
    );

    const page = await lookupPage();

    expect(page).toContain(">Sin respuesta<");
    expect(page).not.toContain(">Rechazado<");
  });

  it("shows the error when the check could not run", async () => {
    execute.mockResolvedValue(Err(new Error("Cálidda no responde")) as never);

    const page = await lookupPage();

    expect(page).toContain(">Error<");
    expect(page).toContain("Cálidda no responde");
    expect(page).not.toContain(">Rechazado<");
  });
});
