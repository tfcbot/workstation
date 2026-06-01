import type { SandboxPort, SandboxDeps } from "./operations";
import { VercelSandbox } from "./vercel";
import { MockSandbox } from "./mock";

// Real adapter is Vercel Sandbox (persistent, by-name). It needs the calling accountId so each
// account gets its own persistent working tree (Sandbox.getOrCreate({ name: accountId })).
// `deps` carry the SDK-injection seam (session-key minter + gateway base URL). Falls back to the
// mock when Vercel credentials are not set.
export function buildSandbox(env: NodeJS.ProcessEnv, accountId: string, deps: SandboxDeps = {}): SandboxPort {
  // Default the SDK base URL to this gateway's own public URL when the host didn't set one.
  const sdkDeps: SandboxDeps = { ...deps, apiUrl: deps.apiUrl ?? env.WORKSTATION_API_URL };
  const teamId = env.VERCEL_TEAM_ID;
  const projectId = env.VERCEL_PROJECT_ID;
  const token = env.VERCEL_TOKEN;
  // If OIDC is in play (VERCEL_OIDC_TOKEN auto-handled by the SDK) the access-token triple may be
  // absent — but for non-Vercel hosting (Convex) we require it.
  if (!teamId || !projectId || !token) return new MockSandbox(sdkDeps);
  return new VercelSandbox({ accountId, teamId, projectId, token, deps: sdkDeps });
}
