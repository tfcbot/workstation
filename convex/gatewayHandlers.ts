import { api, internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import type { Account } from "./auth";
import { type Input, operations } from "../packages/contract/src/index";
import { runAgentLoop } from "../modules/agent/loop";

// Gateway ops don't touch vendors — they read the account / event ledger in the isolate runtime.
// (Port ops go through convex/invoke.ts instead.)
export const gatewayHandlers: Record<
  string,
  (ctx: ActionCtx, account: Account, input: unknown) => Promise<unknown>
> = {
  getBalance: async (_ctx, account) => ({
    accountId: account.accountId,
    creditsCents: account.creditsCents,
    spentCents: account.spentCents,
  }),
  listEvents: async (ctx, account, input) => ({
    events: await ctx.runQuery(api.events.listByAccount, {
      accountId: account.accountId,
      limit: (input as Input<"listEvents">).limit,
    }),
  }),
  createTopup: async (ctx, account, input) =>
    ctx.runAction(internal.payments.createTopupCheckout, {
      accountId: account.accountId,
      amountCents: (input as Input<"createTopup">).amountCents,
    }),
  confirmTopup: async (ctx, account, input) =>
    ctx.runAction(internal.payments.confirmTopup, {
      accountId: account.accountId,
      sessionId: (input as Input<"confirmTopup">).sessionId,
    }),
  // Public (no account) — self-serve signup + claim.
  signup: async (ctx, _account, input) =>
    ctx.runAction(internal.payments.createSignupCheckout, {
      amountCents: (input as Input<"signup">).amountCents,
      scopes: (input as Input<"signup">).scopes,
    }),
  claimSignup: async (ctx, _account, input) =>
    ctx.runAction(internal.payments.claimSignup, {
      claimToken: (input as Input<"claimSignup">).claimToken,
    }),
  // Agent reference capability: an LLM loop whose single tool runs code in the caller's
  // SDK-injected sandbox. Each tool call dispatches through internal.invoke.invoke with the caller's
  // accountId, so every sandbox run mints a session key aliased to the caller. That raw dispatch
  // bypasses the gateway's meter middleware, so this handler debits the sandboxRunWithSdk cost
  // (refunding on failure) around each run — keeping the per-run metering the contract promises.
  agentRun: async (ctx, account, input) => {
    const { goal, maxSteps } = input as Input<"agentRun">;
    const aiGatewayApiKey = process.env.AI_GATEWAY_API_KEY;
    if (!aiGatewayApiKey) throw new Error("AI_GATEWAY_API_KEY is not configured");
    const runCostCents = operations.sandboxRunWithSdk.costCents;
    const { output, steps } = await runAgentLoop({
      goal,
      maxSteps,
      aiGatewayApiKey,
      aiGatewayBaseUrl: process.env.AI_GATEWAY_BASE_URL,
      runCode: async (code) => {
        // Debit up front (throws InsufficientCreditsError when the caller can't cover the run,
        // which aborts the loop and is reported as an operation error).
        await ctx.runMutation(api.accounts.debitCredits, {
          accountId: account.accountId,
          amountCents: runCostCents,
        });
        try {
          return (await ctx.runAction(internal.invoke.invoke, {
            port: "sandbox",
            method: "runWithSdk",
            input: { code },
            accountId: account.accountId,
          })) as { stdout: string; stderr: string; exitCode: number };
        } catch (err) {
          await ctx.runMutation(api.accounts.refundCredits, {
            accountId: account.accountId,
            amountCents: runCostCents,
          });
          throw err;
        }
      },
    });
    return { output, steps };
  },
};
