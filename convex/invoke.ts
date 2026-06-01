"use node";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import { buildPorts } from "./ports";

// One action for every vendor-touching op. The gateway passes the op's serve {port, method}, the
// validated input, AND the caller's accountId — needed by stateful adapters (Vercel Sandbox
// resumes the per-account snapshot by name) and ignored by stateless ones.
export const invoke = internalAction({
  args: { port: v.string(), method: v.string(), input: v.any(), accountId: v.string() },
  handler: async (ctx, { port, method, input, accountId }) => {
    // SDK-injection seam: the sandbox adapter mints a scoped, short-lived bearer key ALIASED to
    // this caller's account (so SDK calls it makes meter against the caller) + gets the gateway's
    // own base URL. ~10-min TTL covers one run.
    const ports = buildPorts(process.env, accountId, {
      sandbox: {
        mintSessionKey: async (scopes: string[]): Promise<string> => {
          const { apiKey } = await ctx.runMutation(api.accounts.mintSessionKey, {
            aliasOf: accountId,
            scopes,
            ttlMs: 10 * 60_000,
          });
          return apiKey;
        },
      },
    }) as unknown as Record<
      string,
      Record<string, (i: unknown) => Promise<unknown>>
    >;
    const adapter = ports[port];
    if (!adapter || typeof adapter[method] !== "function") {
      throw new Error(`unknown port op: ${port}.${method}`);
    }
    return await adapter[method](input); // call on the adapter so `this` is bound
  },
});
