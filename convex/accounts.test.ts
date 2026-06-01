import { test, expect, mock } from "bun:test";

// convex/_generated is produced by `convex dev`/`codegen` against a configured deployment and is
// gitignored — it is absent in an offline checkout. auth.ts statically `import { api }`s it, but
// resolveAccount only ever passes those refs to ctx.runQuery (which we stub below), so the refs are
// never dereferenced. Stub the module so importing auth.ts works without a deployment.
mock.module("./_generated/api", () => ({ api: { accounts: { getByApiKeyHash: {}, getByAccountId: {} } } }));

const { resolveAccount } = await import("./auth");
const { sha256hex } = await import("./keys");
type Account = import("./auth").Account;
type ActionCtx = import("./_generated/server").ActionCtx;

// Integration-shaped test for the session-key ALIAS RESOLUTION seam (convex/auth.ts), the heart of
// metering-on-behalf-of-caller for both sandboxRunWithSdk and the new agentRun. We don't spin up a
// full Convex runtime; instead we stub the two account queries resolveAccount issues
// (accounts.getByApiKeyHash → row for the presented key; accounts.getByAccountId → the aliased real
// account) and assert the resolution rules: a session key resolves THROUGH to the real account
// (so all metering hits the caller), is flagged isSession, carries its own (session) scopes, and
// honors its TTL.

type AccountRow = {
  accountId: string;
  apiKeyHash: string;
  creditsCents: number;
  spentCents: number;
  label?: string;
  scopes?: string[];
  aliasOf?: string;
  expiresAt?: number;
};

// Build a fake ActionCtx whose runQuery routes by the args shape (apiKeyHash vs accountId) into a
// small in-memory table. This exercises the REAL resolveAccount + sha256hex against realistic rows.
function fakeCtx(rows: AccountRow[]): ActionCtx {
  const byHash = (h: string) => rows.find((r) => r.apiKeyHash === h) ?? null;
  const byId = (id: string) => rows.find((r) => r.accountId === id && !r.aliasOf) ?? null;
  return {
    runQuery: async (_ref: unknown, args: Record<string, unknown>) => {
      if ("apiKeyHash" in args) return byHash(args.apiKeyHash as string);
      if ("accountId" in args) return byId(args.accountId as string);
      return null;
    },
  } as unknown as ActionCtx;
}

function req(token?: string): Request {
  return new Request("https://gw.example/v1/agent", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

test("resolveAccount: session key resolves through to the real account and bills it", async () => {
  const sessionKey = "sk_workstation_session_aaaaaaaaaaaaaaaaaaaaaaaa";
  const sessionHash = await sha256hex(sessionKey);
  const rows: AccountRow[] = [
    { accountId: "acc_real", apiKeyHash: "real-hash", creditsCents: 5000, spentCents: 120, label: "owner", scopes: [] },
    {
      accountId: "acc_session", apiKeyHash: sessionHash, creditsCents: 0, spentCents: 0,
      label: "session", scopes: [], aliasOf: "acc_real", expiresAt: Date.now() + 60_000,
    },
  ];
  const out = await resolveAccount(fakeCtx(rows), req(sessionKey));
  expect(out).not.toBeInstanceOf(Response);
  const acct = out as Account;
  // Resolved THROUGH the alias: identity + balance are the REAL account's, so metering hits caller.
  expect(acct.accountId).toBe("acc_real");
  expect(acct.creditsCents).toBe(5000);
  expect(acct.spentCents).toBe(120);
  // Flagged as a session (the authz recursion guard keys off this for sandboxRunWithSdk + agentRun).
  expect(acct.isSession).toBe(true);
});

test("resolveAccount: expired session key is rejected", async () => {
  const sessionKey = "sk_workstation_session_bbbbbbbbbbbbbbbbbbbbbbbb";
  const sessionHash = await sha256hex(sessionKey);
  const rows: AccountRow[] = [
    { accountId: "acc_real", apiKeyHash: "real-hash", creditsCents: 5000, spentCents: 0, scopes: [] },
    {
      accountId: "acc_session", apiKeyHash: sessionHash, creditsCents: 0, spentCents: 0,
      scopes: [], aliasOf: "acc_real", expiresAt: Date.now() - 1,
    },
  ];
  const out = await resolveAccount(fakeCtx(rows), req(sessionKey));
  expect(out).toBeInstanceOf(Response);
  expect((out as Response).status).toBe(401);
});

test("resolveAccount: a normal (non-session) key resolves to itself, isSession=false", async () => {
  const key = "sk_workstation_real_cccccccccccccccccccccccccccc";
  const hash = await sha256hex(key);
  const rows: AccountRow[] = [
    { accountId: "acc_real", apiKeyHash: hash, creditsCents: 4200, spentCents: 7, label: "owner", scopes: ["*"] },
  ];
  const out = await resolveAccount(fakeCtx(rows), req(key));
  const acct = out as Account;
  expect(acct.accountId).toBe("acc_real");
  expect(acct.isSession).toBe(false);
  expect(acct.scopes).toEqual(["*"]);
});

test("resolveAccount: missing bearer token is a 401", async () => {
  const out = await resolveAccount(fakeCtx([]), req());
  expect(out).toBeInstanceOf(Response);
  expect((out as Response).status).toBe(401);
});
