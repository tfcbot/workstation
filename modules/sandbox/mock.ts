import type { SandboxPort, SandboxDeps } from "./operations";
// Module-level tree so a file written in one gateway call is readable in the next.
const files = new Map<string, Buffer>();
export class MockSandbox implements SandboxPort {
  readonly commands: string[] = [];
  disposed = false;
  constructor(private readonly deps: SandboxDeps = {}) {}
  async exec(input: { command: string }) {
    this.commands.push(input.command);
    return { stdout: `[mock] ran: ${input.command}`, stderr: "", exitCode: 0 };
  }
  async putFile(input: { path: string; data: string }) {
    files.set(input.path, Buffer.from(input.data, "base64"));
    return { path: input.path };
  }
  async getFile(input: { path: string }) {
    const b = files.get(input.path);
    return { data: b ? b.toString("base64") : null };
  }
  async dispose() { this.disposed = true; files.clear(); return { ok: true }; }
  async runWithSdk(input: { code: string }) {
    // Exercise the injection seam so tests cover it, without a real VM.
    const key = this.deps.mintSessionKey ? await this.deps.mintSessionKey([]) : "mock-session-key";
    this.commands.push(input.code);
    return {
      stdout: `[mock] ran SDK code (${input.code.length} bytes) with WORKSTATION_API_URL=${this.deps.apiUrl ?? "unset"}, key=${key.slice(0, 6)}…`,
      stderr: "",
      exitCode: 0,
    };
  }
}
