// NOTE: no "use node" directive — this module exports a plain function (not a Convex function
// export), so the directive would be ignored anyway. It runs in the isolate runtime of the
// httpAction that calls it (convex/gateway.ts). The `ai` + `@ai-sdk/google` packages are
// fetch-based and isolate-compatible (no node: builtins), so they must NOT be listed in
// convex.json's node.externalPackages.
import { generateText, tool } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";

// Result of a single sandbox run (mirrors the sandbox execOut shape).
export interface RunCodeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunAgentLoopArgs {
  goal: string;
  maxSteps?: number;
  // Runs agent-authored code in the caller's sandbox (with the Workstation SDK pre-injected and
  // auto-authed). The host wires this to sandboxRunWithSdk via ctx.runAction(internal.invoke.invoke).
  runCode: (code: string) => Promise<RunCodeResult>;
  // Bearer key for the Vercel AI Gateway (Google provider). Required to reach the model.
  aiGatewayApiKey: string;
  // Optional base URL override for the AI Gateway (defaults to Vercel's Google gateway endpoint).
  aiGatewayBaseUrl?: string;
}

export interface RunAgentLoopResult {
  output: string;
  steps: number;
}

export const DEFAULT_MAX_STEPS = 10;
export const HARD_CAP_STEPS = 25;
const DEFAULT_BASE_URL = "https://ai-gateway.vercel.sh/v1/google";
// Fixed model — customers get no choice. Confirmed available on the Vercel AI Gateway
// (GET https://ai-gateway.vercel.sh/v1/models). Bump here to roll the whole agent forward.
const AGENT_MODEL = "gemini-3.5-flash";

const SYSTEM_PROMPT =
  "You are an autonomous engineering agent running inside Workstation. You achieve the user's goal " +
  "by writing and running JavaScript/TypeScript code in a persistent sandbox via the `runCode` tool. " +
  "The sandbox has the `workstation` SDK pre-installed and pre-authed: `import { createClient } from \"workstation\"` " +
  "gives you a client that can call every Workstation capability (filesystem, sandbox, etc.) billed to the caller. " +
  "Inspect tool results (stdout/stderr/exitCode), iterate as needed, and when the goal is met, stop calling " +
  "tools and reply with a concise summary of what you accomplished.";

// The agent loop: AI SDK generateText with a single tool (`runCode`) and multi-step tool calling.
// Pure relative to Convex — the host injects `runCode` + the AI Gateway key. Returns the model's
// final text and the number of steps taken.
export async function runAgentLoop(args: RunAgentLoopArgs): Promise<RunAgentLoopResult> {
  const maxSteps = Math.min(args.maxSteps ?? DEFAULT_MAX_STEPS, HARD_CAP_STEPS);

  const google = createGoogleGenerativeAI({
    apiKey: args.aiGatewayApiKey,
    baseURL: args.aiGatewayBaseUrl ?? DEFAULT_BASE_URL,
  });

  const result = await generateText({
    model: google(AGENT_MODEL),
    system: SYSTEM_PROMPT,
    prompt: args.goal,
    maxSteps,
    tools: {
      runCode: tool({
        description:
          "Run JavaScript/TypeScript code in the caller's sandbox. The `workstation` SDK is " +
          "pre-installed and pre-authed (import { createClient } from \"workstation\"). Returns " +
          "{ stdout, stderr, exitCode }.",
        parameters: z.object({
          code: z.string().describe("The code to run in the sandbox."),
        }),
        execute: async ({ code }) => args.runCode(code),
      }),
    },
  });

  return { output: result.text, steps: result.steps.length };
}
