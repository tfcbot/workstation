import { DEFAULT_MAX_STEPS, HARD_CAP_STEPS, type RunAgentLoopArgs, type RunAgentLoopResult } from "./loop";

// A deterministic stand-in for runAgentLoop that does NOT hit a real LLM. It simulates a model that
// decides to call the `runCode` tool once (running a tiny SDK snippet through the injected sandbox),
// observes the result, and then produces a final summary. Used by agent.test.ts so the loop's wiring
// (tool dispatch → runCode → sandbox) is exercised without network/model dependencies.
export async function runAgentLoopMock(args: RunAgentLoopArgs): Promise<RunAgentLoopResult> {
  const maxSteps = Math.min(args.maxSteps ?? DEFAULT_MAX_STEPS, HARD_CAP_STEPS);
  const code = 'import { createClient } from "workstation";\nconst ws = createClient();\nawait ws.fsWrite("out.txt", "done");';
  const res = await args.runCode(code);
  // One tool step + one final-answer step.
  const steps = Math.min(2, maxSteps);
  return {
    output: `Goal "${args.goal}" handled. sandbox exitCode=${res.exitCode}; stdout=${res.stdout}`,
    steps,
  };
}
