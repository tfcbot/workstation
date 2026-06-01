import { z } from "zod";
import { op } from "../../packages/contract/src/op";

// Inputs/outputs for the agent run. `goal` is the natural-language objective; `maxSteps` caps the
// number of LLM round-trips (each may call the `runCode` tool once). Hard-capped server-side.
const runIn = z.object({
  goal: z.string().min(1),
  maxSteps: z.coerce.number().int().min(1).max(25).optional(),
});
const runOut = z.object({ output: z.string(), steps: z.number() });

// The Agent reference capability: a metered LLM loop that drives the Computer primitive. The model
// is given ONE tool — `runCode` — which runs agent-authored code in the caller's sandbox with the
// Workstation SDK pre-injected and auto-authed (via sandboxRunWithSdk). Because the loop orchestrates
// an arbitrary number of metered sandbox runs on the caller's behalf, it charges a flat 50-credit
// orchestration fee up front; each sandbox run it triggers is itself metered (15 credits) separately.
//
// This is a GATEWAY op (serve: { gateway: true }), NOT a port op: the handler needs ActionCtx to call
// `ctx.runAction(internal.invoke.invoke, ...)` for each tool call — exactly like createTopup/confirmTopup.
// Port adapters are built inside `invoke` and cannot call ctx.runAction. The billing guard is the
// access control (gateway ops carry no scope; see packages/contract/src/scope.ts).
export const ops = {
  agentRun: op({
    method: "POST", path: "/v1/agent", inputFrom: "body",
    input: runIn, output: runOut, costCents: 50,
    summary: "Run an autonomous agent loop that drives the sandbox to achieve a goal (50-credit orchestration fee; each sandbox run it triggers is metered separately)",
    serve: { gateway: true },
  }),
};
