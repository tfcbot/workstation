import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Per-key accounts (SPEC §7.1). A bearer key resolves to one account with a credit balance.
  accounts: defineTable({
    accountId: v.string(),
    apiKeyHash: v.string(), // SHA-256 of the key; plaintext never stored
    creditsCents: v.number(),
    spentCents: v.number(),
    label: v.string(),
    scopes: v.array(v.string()), // reserved for operator-defined permissions; Workstation does not act on it
    // Session keys: a short-lived key whose row carries `aliasOf` (the real account it bills) and
    // `expiresAt`. resolveAccount follows the alias so the session key shares the caller's balance.
    // Injected into the sandbox so the SDK's calls meter against the caller. Absent on normal keys.
    aliasOf: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_apiKeyHash", ["apiKeyHash"])
    .index("by_accountId", ["accountId"]),

  // Fixed-window rate-limit counters (SPEC §7.x). Off unless WORKSTATION_RATE_LIMIT_PER_MIN is set.
  rateLimits: defineTable({
    key: v.string(),
    count: v.number(),
    windowStart: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // Fulfilled Stripe Checkout sessions — makes crediting idempotent (webhook AND poll can both
  // fire; a session is credited at most once).
  topups: defineTable({
    sessionId: v.string(),
    accountId: v.string(),
    amountCents: v.number(),
    ts: v.number(),
  }).index("by_sessionId", ["sessionId"]),

  // Self-serve signup claim tokens. A public POST /v1/signup creates a Checkout session + an
  // unguessable claimToken; the buyer polls POST /v1/signup/claim, which mints their key once the
  // session is paid. accountId is set when claimed, so a token mints at most one key (idempotent).
  claims: defineTable({
    claimToken: v.string(),
    sessionId: v.string(),
    accountId: v.optional(v.string()), // set on first successful claim
    createdAt: v.number(),
    claimedAt: v.optional(v.number()),
  }).index("by_claimToken", ["claimToken"]),

  // Generic usage/observability ledger — one row per gated primitive call.
  events: defineTable({
    accountId: v.string(),
    op: v.string(),
    costCents: v.number(),
    status: v.string(),
    ts: v.number(),
  }).index("by_accountId", ["accountId"]),
});
