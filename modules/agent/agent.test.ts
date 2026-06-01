import { test, expect } from "bun:test";
import { runAgentLoopMock } from "./mock";
import { MockSandbox } from "../sandbox/mock";

// The agent loop drives the sandbox via the injected `runCode`. Here we wire `runCode` to a
// MockSandbox's runWithSdk (which exercises the session-key minting seam), proving the loop calls
// the tool, the tool reaches the sandbox, and the sandbox sees the SDK-injection deps.
test("runAgentLoop (mock): drives runCode through the SDK-injected sandbox", async () => {
  let mintedScopes: string[] | null = null as string[] | null;
  const sandbox = new MockSandbox({
    apiUrl: "https://gw.example",
    mintSessionKey: async (scopes) => {
      mintedScopes = scopes;
      return "sess_abcdef_secret";
    },
  });

  const result = await runAgentLoopMock({
    goal: "write out.txt to storage",
    maxSteps: 10,
    aiGatewayApiKey: "test-key",
    runCode: async (code) => sandbox.runWithSdk({ code }),
  });

  // The tool ran exactly one sandbox snippet, and it was the SDK-importing code.
  expect(sandbox.commands.length).toBe(1);
  expect(sandbox.commands[0]).toContain('import { createClient } from "workstation"');
  // The injection seam was used (empty scopes = full access on behalf of caller).
  expect(mintedScopes).toEqual([]);
  // The loop returned the model's final text + a step count within the cap.
  expect(result.output).toContain("exitCode=0");
  expect(result.steps).toBeGreaterThan(0);
  expect(result.steps).toBeLessThanOrEqual(10);
});

test("runAgentLoop (mock): respects maxSteps cap", async () => {
  const sandbox = new MockSandbox();
  const result = await runAgentLoopMock({
    goal: "anything",
    maxSteps: 1,
    aiGatewayApiKey: "test-key",
    runCode: async (code) => sandbox.runWithSdk({ code }),
  });
  expect(result.steps).toBeLessThanOrEqual(1);
});
