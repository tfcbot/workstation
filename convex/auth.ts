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

export function forbidden(detail: string): Response {
  return json({ error: "forbidden", message: detail }, 403);
}

export function getBearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7);
}

// RFC 7807 Problem Details for HTTP 402, plus a WWW-Authenticate: Payment header so a
// payment-capable agent (MPP / x402) can resolve the charge inline.
export function paymentRequired(
  detail: string,
  required: number,
  balance: number,
  topupUrl: string,
): Response {
  return new Response(
    JSON.stringify({
      type: "https://paymentauth.org/problems/payment-required",
      title: "Payment Required",
      status: 402,
      detail,
      required,
      balance,
      topupUrl,
    }),
    {
      status: 402,
      headers: {
        "Content-Type": "application/problem+json",
        "WWW-Authenticate": `Payment topupUrl="${topupUrl}"`,
      },
    },
  );
}

// HTTP 429 for rate-limited callers, with a Retry-After header (abuse protection, SPEC §7.5).
export function rateLimited(retryAfter: number, limit: number): Response {
  return new Response(
    JSON.stringify({
      error: "rate_limit_exceeded",
      message: `Rate limit of ${limit}/window exceeded. Retry after ${retryAfter}s.`,
      retryAfter,
    }),
    { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(retryAfter) } },
  );
}

/** Resolve the caller's account from the bearer key, or return a 401 Response. */
export async function resolveAccount(ctx: ActionCtx, req: Request): Promise<Account | Response> {
  const token = getBearerToken(req);
  if (!token) {
    return json({ error: "auth_required", message: "Missing 'Authorization: Bearer <key>'." }, 401);
  }
  const apiKeyHash = await sha256hex(token);
  const acct = await ctx.runQuery(api.accounts.getByApiKeyHash, { apiKeyHash });
  if (!acct) {
    return json({ error: "auth_required", message: "Invalid API key." }, 401);
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
