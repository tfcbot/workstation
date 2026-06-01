"use node";
import type { Ports } from "../packages/contract/src/index";
import type { SandboxDeps } from "../modules/sandbox/operations";
import { buildSandbox } from "../modules/sandbox/server";
import { buildFileSystem } from "../modules/filesystem/server";

// Host-supplied deps for adapters that call back into the gateway at dispatch time (otherwise the
// adapters are pure). Currently just the sandbox's SDK-injection seam (session-key minter + URL).
export interface PortDeps {
  sandbox?: SandboxDeps;
}

// Each capability module owns its real-or-mock decision (its server.ts). Add a capability =
// its module + one line here. accountId is threaded for adapters that scope state per caller
// (notably Sandbox, whose Vercel adapter resumes a per-account snapshot by name).
export function buildPorts(
  env: NodeJS.ProcessEnv = process.env,
  accountId: string,
  deps: PortDeps = {},
): Ports {
  return {
    sandbox: buildSandbox(env, accountId, deps.sandbox),
    filesystem: buildFileSystem(env),
  };
}
