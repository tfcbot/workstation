// Per-key account auth (SPEC §7.1). No single shared gateway key: every request carries a
// bearer key that resolves to an account with a credit balance. The operator mints + owns keys
// (see convex/accounts.ts mintKey). Workstation defines no bypass/admin tier.
import { api } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { sha256hex } from "./keys";

export interface Account {
  accountId: string;
  creditsCents: number;
  spentCents: number;
  label: string;
  scopes: string[];
  isSession: boolean; // true when resolved via a session key (aliased to a real account)
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Operator's deployed front door (where topup / signup CTAs live). Falls back to the prior
// WORKSTATION_LANDING_URL / WORKSTATION_TOPUP_URL names so existing deployments don't break.
export function baseUrl(): string {
  return (
    process.env.WORKSTATION_BASE_URL ??
    process.env.WORKSTATION_LANDING_URL ??
    process.env.WORKSTATION_TOPUP_URL ??
    "https://workstation.example"
  );
}

// 403 forbidden — uniform envelope carrying both the scope the op needs and the scopes the key has,
// so a caller can see exactly what grant is missing.
export function forbidden(requiredScope: string, grantedScopes: string[]): Response {
  return json(
    {
      error: "forbidden",
      message: `key not scoped for ${requiredScope}`,
      requiredScope,
      grantedScopes,
    },
    403,
  );
}

// Thrown when a vendor/upstream adapter (Vercel Sandbox, R2, Stripe, …) fails. The gateway maps it
// to a 5xx { error:"upstream_error", retryable:true } instead of collapsing it into an opaque 4xx,
// so callers can tell a transient backend hiccup from their own bad request.
export class UpstreamError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
}

export function getBearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7);
}

// HTTP 402 with the canonical { error, message, ... } envelope AND the RFC 7807 Problem Details
// fields (type/title/status/detail) kept for back-compat, plus a WWW-Authenticate: Payment header
// (now carrying the amount) so a payment-capable agent (MPP / x402) can resolve the charge inline.
export function paymentRequired(
  detail: string,
  required: number,
  balance: number,
  topupUrl: string,
): Response {
  const shortfall = Math.max(0, required - balance);
  return new Response(
    JSON.stringify({
      error: "payment_required",
      message: detail,
      required,
      balance,
      shortfall,
      topupUrl,
      // RFC 7807 fields (back-compat)
      type: "https://paymentauth.org/problems/payment-required",
      title: "Payment Required",
      status: 402,
      detail,
    }),
    {
      status: 402,
      headers: {
        "Content-Type": "application/problem+json",
        "WWW-Authenticate": `Payment topupUrl="${topupUrl}", amount="${shortfall}"`,
      },
    },
  );
}

// HTTP 429 for rate-limited callers, with a Retry-After header (abuse protection, SPEC §7.5).
export function rateLimited(retryAfter: number, limit: number): Response {
  return new Response(
    JSON.stringify({
      error: "rate_limited",
      message: `Rate limit of ${limit}/window exceeded. Retry after ${retryAfter}s.`,
      retryAfter,
    }),
    { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(retryAfter) } },
  );
}

/** Resolve the caller's account from the bearer key, or return a 401 Response. */
export async function resolveAccount(ctx: ActionCtx, req: Request): Promise<Account | Response> {
  // signupUrl points a keyless agent at the public self-provision endpoint (POST /v1/signup).
  const signupUrl = `${baseUrl()}/v1/signup`;
  const token = getBearerToken(req);
  if (!token) {
    return json(
      { error: "unauthorized", message: "Missing 'Authorization: Bearer <key>'.", signupUrl },
      401,
    );
  }
  const apiKeyHash = await sha256hex(token);
  const acct = await ctx.runQuery(api.accounts.getByApiKeyHash, { apiKeyHash });
  if (!acct) {
    return json({ error: "unauthorized", message: "Invalid API key.", signupUrl }, 401);
  }

  // Session key (e.g. injected into the sandbox): it holds no balance of its own — it bills the
  // account named by `aliasOf`. Honor its TTL, then resolve through to the real account so all
  // metering hits the caller; keep the session key's (narrower) scopes + flag it as a session.
  if (acct.aliasOf) {
    if (acct.expiresAt && acct.expiresAt < Date.now()) {
      return json({ error: "auth_required", message: "Session key expired." }, 401);
    }
    const real = await ctx.runQuery(api.accounts.getByAccountId, { accountId: acct.aliasOf });
    if (!real) {
      return json({ error: "auth_required", message: "Invalid API key." }, 401);
    }
    return {
      accountId: real.accountId,
      creditsCents: real.creditsCents,
      spentCents: real.spentCents,
      label: real.label ?? "",
      scopes: acct.scopes ?? [],
      isSession: true,
    };
  }

  return {
    accountId: acct.accountId,
    creditsCents: acct.creditsCents,
    spentCents: acct.spentCents,
    label: acct.label ?? "",
    scopes: acct.scopes ?? [],
    isSession: false,
  };
}
