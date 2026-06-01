import type { HttpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal, api } from "./_generated/api";
import {
  json, paymentRequired, rateLimited, forbidden, resolveAccount, baseUrl, UpstreamError, type Account,
} from "./auth";
import { operations, scopeAllows, scopeOf, type OperationId } from "../packages/contract/src/index";
import { gatewayHandlers } from "./gatewayHandlers";
import { runPipeline, type Middleware, type GwRequest } from "./middleware";

// The gateway builds every route from the registry, composing per-op middleware (Middy-style:
// before/after/onError over a shared request). Each cross-cutting concern is one wrapper; an op
// opts out via its policy (auth: "public" skips auth; metered: false / costCents 0 skips billing).
// Adding an op never touches this file; adding a new concern = one more middleware.

function topupUrl(accountId: string): string {
  // baseUrl() = operator's deployed front door (where they wire a topup CTA).
  return `${baseUrl()}/?account=${encodeURIComponent(accountId)}`;
}
const isMetered = (op: GwRequest["op"]) => op.metered !== false && op.costCents > 0;

// ── middlewares ───────────────────────────────────────────────────────────────
const auth: Middleware = {
  name: "auth",
  async before(r) {
    if ((r.op.auth ?? "key") === "public") return;
    const a = await resolveAccount(r.ctx, r.httpRequest);
    if (a instanceof Response) r.response = a;
    else r.account = a;
  },
};

const authz: Middleware = {
  name: "authz",
  before(r) {
    if (!r.account) return; // public ops carry no key to scope-check
    // Recursion guard: a session key (the one injected into the sandbox) MUST NOT spawn another
    // SDK-injected sandbox — otherwise agent code could nest sandboxes without bound. It may call
    // every other op (that's the whole point); just not this one.
    if (r.account.isSession && (r.opId === "sandboxRunWithSdk" || r.opId === "agentRun")) {
      r.response = forbidden("session keys cannot start a nested SDK sandbox or agent run");
      return;
    }
    if (!scopeAllows(r.account.scopes, r.op)) {
      r.response = forbidden(scopeOf(r.op) ?? "(none)", r.account.scopes);
    }
  },
};

const rateLimit: Middleware = {
  name: "rateLimit",
  async before(r) {
    const perMin = Number(process.env.WORKSTATION_RATE_LIMIT_PER_MIN ?? 0);
    if (!perMin || !r.account) return;
    const res = await r.ctx.runMutation(api.ratelimit.consume, {
      bucket: `${r.account.accountId}:${r.opId}`,
      limit: perMin,
      windowMs: 60_000,
    });
    if (!res.allowed) r.response = rateLimited(res.retryAfter ?? 60, res.limit);
  },
};

const meter: Middleware = {
  name: "meter",
  async before(r) {
    if (!isMetered(r.op) || !r.account) return;
    const cost = r.op.costCents;
    if (cost > r.account.creditsCents) {
      r.response = paymentRequired(
        `Operation ${r.opId} costs ${cost} credits; balance is ${r.account.creditsCents}.`,
        cost, r.account.creditsCents, topupUrl(r.account.accountId),
      );
      return;
    }
    await r.ctx.runMutation(api.accounts.debitCredits, { accountId: r.account.accountId, amountCents: cost });
    r.charged = cost;
  },
  async after(r) {
    // refund if we debited but the call didn't succeed (short-circuited downstream, e.g. 400)
    if (r.charged > 0 && r.account && (r.response || r.output === undefined)) {
      await r.ctx.runMutation(api.accounts.refundCredits, { accountId: r.account.accountId, amountCents: r.charged });
      r.charged = 0;
    }
  },
  async onError(r) {
    if (r.charged > 0 && r.account) {
      await r.ctx.runMutation(api.accounts.refundCredits, { accountId: r.account.accountId, amountCents: r.charged });
      r.charged = 0;
    }
  },
};

const validate: Middleware = {
  name: "validate",
  async before(r) {
    const raw = r.op.inputFrom === "query"
      ? Object.fromEntries(new URL(r.httpRequest.url).searchParams.entries())
      : await r.httpRequest.json().catch(() => ({}));
    const parsed = r.op.input.safeParse(raw);
    if (!parsed.success) {
      // Surface Zod issues as a first-class array (path + message), not a stringified blob.
      const issues = parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      }));
      r.response = json(
        { error: "invalid_request", message: "Request failed validation.", issues },
        400,
      );
    } else r.input = parsed.data;
  },
};

const events: Middleware = {
  name: "events",
  async after(r) {
    if (!r.account) return;
    const status = r.output !== undefined && !r.response
      ? "ok"
      : r.response?.status === 402 ? "payment_required"
      : r.response?.status === 429 ? "rate_limited"
      : r.response?.status === 403 ? "forbidden"
      : "error";
    await record(r, status);
  },
  async onError(r) {
    if (r.account) await record(r, "error");
  },
};
async function record(r: GwRequest, status: string) {
  await r.ctx.runMutation(api.events.record, {
    accountId: r.account!.accountId, op: r.opId, costCents: r.charged, status,
  });
  const hook = process.env.WORKSTATION_WEBHOOK_URL;
  if (hook) {
    void fetch(hook, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: r.account!.accountId, op: r.opId, status, ts: Date.now() }),
    }).catch(() => {});
  }
}

// ── the core (dispatch) ─────────────────────────────────────────────────────────
async function dispatch(r: GwRequest) {
  if ("gateway" in r.op.serve) {
    r.output = await gatewayHandlers[r.opId](r.ctx, r.account as Account, r.input);
  } else {
    // Port ops hit a vendor adapter (Vercel Sandbox / R2 / …). A throw here is an upstream
    // failure, not the caller's fault — tag it so the top-level catch emits a retryable 5xx.
    try {
      r.output = await r.ctx.runAction(internal.invoke.invoke, {
        port: r.op.serve.port, method: r.op.serve.method, input: r.input,
        accountId: r.account!.accountId,
      });
    } catch (err) {
      throw new UpstreamError((err as Error).message);
    }
  }
}

export function buildRouter(router: HttpRouter): void {
  for (const [opId, op] of Object.entries(operations)) {
    const stack: Middleware[] = [events, auth, authz, rateLimit, meter, validate];
    const pipeline = runPipeline(stack, dispatch);
    const handler = httpAction(async (ctx, httpRequest) => {
      const r: GwRequest = {
        ctx, httpRequest, opId, op, account: null, charged: 0,
        input: undefined, output: undefined, response: null,
      };
      try {
        await pipeline(r);
      } catch (err) {
        // Vendor/upstream throws → retryable 5xx; domain/validation throws keep a stable 4xx.
        if (err instanceof UpstreamError) {
          return json(
            { error: "upstream_error", message: err.message, retryable: true },
            err.status,
          );
        }
        return json({ error: "operation_error", message: (err as Error).message }, 409);
      }
      return r.response ?? json(r.output);
    });
    router.route({ path: op.path, method: op.method, handler });
  }
}
