import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { sha256hex, generateApiKey } from "./keys";
import { debit as debitBalance, grant as grantBalance, refund as refundBalance } from "../core/domain/credits";

// Per-key accounts — Workstation's analog of VidJutsu's machineClients. A bearer key resolves to one
// of these. The single-node OPERATOR mints + distributes keys and owns their permissions.
// Workstation defines NO bypass/admin tier: billing applies uniformly (see core/domain/pricing.ts).

function newAccountId(): string {
  return `acc_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/**
 * Mint an API key. Returns the plaintext key ONCE (only its hash is stored).
 * Bootstrap a fresh deployment with:
 *   bunx convex run accounts:mintKey '{"label":"owner","creditsCents":100000}'
 * Zero-cost operations work on any key (even 0 balance); billable ops need credits.
 */
export const mintKey = mutation({
  args: { creditsCents: v.optional(v.number()), label: v.optional(v.string()), scopes: v.optional(v.array(v.string())) },
  handler: async (ctx, { creditsCents, label, scopes }) => {
    const apiKey = generateApiKey();
    const apiKeyHash = await sha256hex(apiKey);
    const now = Date.now();
    const accountId = newAccountId();
    await ctx.db.insert("accounts", {
      accountId,
      apiKeyHash,
      creditsCents: creditsCents ?? 0,
      spentCents: 0,
      label: label ?? "",
      scopes: scopes ?? [],
      createdAt: now,
      updatedAt: now,
    });
    return { apiKey, accountId };
  },
});

export const getByApiKeyHash = query({
  args: { apiKeyHash: v.string() },
  handler: async (ctx, { apiKeyHash }) =>
    await ctx.db
      .query("accounts")
      .withIndex("by_apiKeyHash", (q) => q.eq("apiKeyHash", apiKeyHash))
      .unique(),
});

export const getByAccountId = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) =>
    await ctx.db
      .query("accounts")
      .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
      .unique(),
});

/**
 * Mint a short-lived SESSION key that bills the caller's account (`aliasOf`). It holds no balance
 * of its own; resolveAccount follows the alias to the real account. Injected into the sandbox so
 * agent-written SDK code authenticates and meters as the caller. Returns the plaintext key once.
 */
export const mintSessionKey = mutation({
  args: { aliasOf: v.string(), scopes: v.optional(v.array(v.string())), ttlMs: v.optional(v.number()) },
  handler: async (ctx, { aliasOf, scopes, ttlMs }) => {
    const apiKey = generateApiKey();
    const apiKeyHash = await sha256hex(apiKey);
    const now = Date.now();
    await ctx.db.insert("accounts", {
      accountId: newAccountId(), // own id; balance is the aliased account's
      apiKeyHash,
      creditsCents: 0,
      spentCents: 0,
      label: "session",
      scopes: scopes ?? [],
      aliasOf,
      expiresAt: now + (ttlMs ?? 10 * 60_000),
      createdAt: now,
      updatedAt: now,
    });
    return { apiKey };
  },
});

export const getBalance = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    const a = await ctx.db
      .query("accounts")
      .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
      .unique();
    if (!a) return null;
    return { accountId, creditsCents: a.creditsCents, spentCents: a.spentCents };
  },
});

// Atomic debit: read → check (pure domain) → patch, all inside one mutation (no race).
export const debitCredits = mutation({
  args: { accountId: v.string(), amountCents: v.number() },
  handler: async (ctx, { accountId, amountCents }) => {
    const a = await ctx.db
      .query("accounts")
      .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
      .unique();
    if (!a) throw new Error(`account_not_found:${accountId}`);
    const next = debitBalance({ creditsCents: a.creditsCents, spentCents: a.spentCents }, amountCents);
    await ctx.db.patch(a._id, { ...next, updatedAt: Date.now() });
    return next;
  },
});

// Refund a debit (gate calls this when a vendor op fails after charging) — restores credits AND spent.
export const refundCredits = mutation({
  args: { accountId: v.string(), amountCents: v.number() },
  handler: async (ctx, { accountId, amountCents }) => {
    const a = await ctx.db
      .query("accounts")
      .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
      .unique();
    if (!a) return null;
    const next = refundBalance({ creditsCents: a.creditsCents, spentCents: a.spentCents }, amountCents);
    await ctx.db.patch(a._id, { ...next, updatedAt: Date.now() });
    return next;
  },
});

/**
 * Add credits to an account — the funding SEAM. Workstation ships no payment processor: an operator's
 * own rail calls this to settle. Reachable only server-side (no HTTP route), so a caller can
 * never credit itself. Use it for:
 *   - manual top-up:        bunx convex run accounts:grantCredits '{"accountId":"acc_…","amountCents":5000}'
 *   - subscription grant:   a scheduled function that grants N cents/month
 *   - a payment webhook:    e.g. @convex-dev/stripe's checkout.session.completed handler
 */
export const grantCredits = mutation({
  args: { accountId: v.string(), amountCents: v.number() },
  handler: async (ctx, { accountId, amountCents }) => {
    const a = await ctx.db
      .query("accounts")
      .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
      .unique();
    if (!a) throw new Error(`account_not_found:${accountId}`);
    const next = grantBalance({ creditsCents: a.creditsCents, spentCents: a.spentCents }, amountCents);
    await ctx.db.patch(a._id, { ...next, updatedAt: Date.now() });
    return { accountId, ...next };
  },
});
