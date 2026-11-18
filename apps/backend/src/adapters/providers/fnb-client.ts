import { env } from "cloudflare:workers";
import { decodeBase64urlIgnorePadding } from "@oslojs/encoding";
import type { CaliddaLogin } from "../../domains/settings/calidda.ts";
import { clearBlock } from "./health.ts";
import { createLogger } from "../../lib/logger.ts";
import { createAbortTimeout, TIMEOUTS } from "../../config/timeouts.ts";

const logger = createLogger("fnb-client");

type FNBSession = {
  token: string;
  allyId: string;
};

type FNBAuthResponse = {
  valid: boolean;
  message?: string;
  data?: {
    authToken: string;
  };
};

type FNBCreditResponse = {
  valid: boolean;
  data?: {
    lineaCredito?: string;
    nombre?: string;
  };
};

type JwtPayload = {
  commercialAllyId: string;
};

/**
 * A tenant's FNB session serves every isolate: it is kept in KV for a little
 * under the hour the token lives, so a login is not repeated per request. The
 * token is the tenant's own Cálidda account's, so the key is per tenant.
 */
const SESSION_TTL_S = 3500;
const sessionKey = (tenantId: string) => `fnb:session:${tenantId}`;

/**
 * Drops the tenant's cached session and its circuit-breaker block. Called when
 * the tenant's login changes, so the next check authenticates with the new
 * credentials instead of the old account's hour-long token or a stale block.
 */
export async function clearFnbState(tenantId: string): Promise<void> {
  await Promise.all([
    env.KV.delete(sessionKey(tenantId)),
    clearBlock("fnb", tenantId),
  ]);
}

/** The token's payload names the ally. Its signature is the issuer's to check. */
function jwtPayload(token: string): JwtPayload | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(
      new TextDecoder().decode(decodeBase64urlIgnorePadding(part)),
    ) as JwtPayload;
  } catch {
    return null;
  }
}

async function authenticate(login: CaliddaLogin): Promise<FNBSession> {
  const cached = await env.KV.get<FNBSession>(
    sessionKey(login.tenantId),
    "json",
  );
  if (cached) return cached;

  const baseUrl = login.baseUrl.replace(/\/+$/, "");
  const origin = new URL(baseUrl).origin;
  const authUrl = `${baseUrl}/FNB_Services/api/Seguridad/autenticar`;

  const { signal, cleanup } = createAbortTimeout(TIMEOUTS.FNB_AUTH);

  try {
    const response = await fetch(authUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        referer: `${baseUrl}/WebFNB/login`,
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      body: JSON.stringify({
        usuario: login.username,
        password: login.password,
        captcha: "exitoso",
        Latitud: "",
        Longitud: "",
      }),
      signal,
    });

    cleanup();

    if (!response.ok) {
      throw new Error(`FNB Auth HTTP ${response.status}`);
    }

    const data = (await response.json()) as FNBAuthResponse;

    if (!(data.valid && data.data?.authToken)) {
      throw new Error(`FNB Auth Invalid: ${data.message || "No token"}`);
    }

    const decoded = jwtPayload(data.data.authToken);
    if (!decoded) {
      throw new Error("Failed to decode JWT token");
    }

    const session: FNBSession = {
      token: data.data.authToken,
      allyId: decoded.commercialAllyId,
    };
    await env.KV.put(sessionKey(login.tenantId), JSON.stringify(session), {
      expirationTtl: SESSION_TTL_S,
    });

    logger.debug("FNB authentication successful");
    return session;
  } catch (error) {
    cleanup();

    if (error instanceof Error) {
      if (error.name === "AbortError") {
        logger.error(
          { timeoutMs: TIMEOUTS.FNB_AUTH },
          "FNB authentication timeout",
        );
        throw new Error(`FNB Auth Timeout after ${TIMEOUTS.FNB_AUTH}ms`);
      }
      logger.error({ error: error.message }, "FNB authentication failed");
    }

    throw error;
  }
}

async function queryCreditLine(
  dni: string,
  login: CaliddaLogin,
): Promise<FNBCreditResponse> {
  const session = await authenticate(login);

  const params = new URLSearchParams({
    numeroDocumento: dni,
    tipoDocumento: "PE2",
    idAliado: session.allyId,
    canal: "FNB",
  });

  const baseUrl = login.baseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/FNB_Services/api/financiamiento/lineaCredito?${params}`;

  const { signal, cleanup } = createAbortTimeout(TIMEOUTS.FNB_QUERY);

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "application/json",
        referer: `${baseUrl}/WebFNB/consulta-credito`,
      },
      signal,
    });

    cleanup();

    if (!res.ok) {
      throw new Error(`FNB Query Failed: ${res.status}`);
    }

    const data = (await res.json()) as FNBCreditResponse;

    logger.debug(
      { dni, hasCredit: data.valid && !!data.data?.lineaCredito },
      "FNB credit query completed",
    );

    return data;
  } catch (error) {
    cleanup();

    if (error instanceof Error) {
      if (error.name === "AbortError") {
        logger.error(
          { dni, timeoutMs: TIMEOUTS.FNB_QUERY },
          "FNB credit query timeout",
        );
        throw new Error(`FNB Query Timeout after ${TIMEOUTS.FNB_QUERY}ms`);
      }
      logger.error({ error: error.message, dni }, "FNB credit query failed");
    }

    throw error;
  }
}

export const FNBClient = {
  authenticate,
  queryCreditLine,
};
