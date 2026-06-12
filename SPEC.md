# Workstation — Protocol

> A headless contract for agents that do work. Version 0.1 (draft).

This document specifies the protocol normatively — enough to implement it in any language or
stack, the way an OAuth or webhook spec does. The reasoning behind every choice lives in
[THESIS.md](./THESIS.md); a worked example in [SCENARIOS.md](./SCENARIOS.md).

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are used as in
RFC 2119.

---

## 1. Abstract

Workstation is a headless backend that exposes a
a metered, key-gated HTTP **gateway** with two reference **capabilities** — sandbox (compute)
and filesystem (storage). The framework's own primitives are the gateway concerns (keys,
access control, metering, rate limits, observability); capabilities are the operator's surface. An
external **Agent** (the brain, brought by the caller) calls the primitives to accomplish work and
**coordinates that work itself**. The platform does not own that orchestrating Agent; it serves
the contract. (What an implementation places *behind* a contract endpoint — a deterministic
pipeline, a single LLM call, or an internal agent loop — is unconstrained by this spec.) A
conforming implementation lets any agent reach people, run code, and persist deliverables — a
complete loop — without the caller's own credentials, and meters each call.

Workstation is **not** a task manager: tracking and sequencing work is the Agent's job, not the
workstation's. The workstation's durable contribution is the **gateway** — identity (per-key accounts), metering
(credits), abuse protection (rate limits), and observability (an event ledger) — over swappable
primitive adapters.

## 2. Roles

- **Principal** — the human customer. Owns their Agent and their data.
- **Agent** — the LLM/automation that calls the contract (the "client" in the protocol sense).
  Out of scope to specify; brought by the Principal or Provider.
- **Provider** — operates a deployment of Workstation. In self-host mode the Principal is the
  Provider; the Provider mints and owns API keys.
- **Workstation / Platform** — the conforming backend specified here. It MUST NOT operate agents.

## 3. Conformance

An implementation conforms to this protocol if and only if it:

1. implements the reference capability interfaces in §5 (an implementation MAY add or replace, §10);
2. exposes each primitive operation over the Gateway HTTP API (§7) with the authentication in §7.1;
3. meters billable operations deterministically and returns `402` on an empty balance (§7.4);
4. honors the security requirements in §9 — in particular, it MUST NOT expose secrets as a
   primitive or endpoint.

Vendor choices (§11) are **informative**: any adapter satisfying a primitive's interface conforms.

## 4. Architecture

The Agent calls **one** HTTP contract. The **gateway** is the deterministic spine: it
authenticates the key to an account, meters/limits the call, routes it to a primitive, and records
an event. Each primitive is a **port** with a swappable **adapter**. Business-critical logic
(identity, credit accounting, rate limits) MUST live in this deterministic layer, never inside an
agent.

```
   Agent (brain, external) ──HTTP──► Gateway
                                       │  auth → rate limit (429) → meter (402)
                                       │  → validate → route → event log
                                       │
                                   ┌───┴───────────┐
                                Sandbox       FileSystem
                                (port)        (port)
                                   │             │
                                adapter       adapter
```

The Agent MUST NOT be required to address adapters directly; it interacts only with the gateway
contract. The contract is defined as a typed **operation registry** (§6); the gateway exposes
every registry entry uniformly.

## 5. Primitives

Each reference capability is defined by an interface (language-neutral; `bytes` = binary blob,
`?` = optional/nullable). A conforming implementation MUST provide an adapter for each. Binary
payloads cross the HTTP contract as base64.

### 5.1 Sandbox (compute)
```
exec(command: string) -> { stdout: string, stderr: string, exitCode: int }
putFile(path: string, data: bytes|string) -> void
getFile(path: string) -> bytes?
dispose() -> void
```
A conforming Sandbox MUST run unrestricted code in isolation from the Principal's accounts (§9)
and SHOULD provide a full POSIX environment (so tools like ffmpeg and git run). Because primitive
calls are independent HTTP requests, a conforming Sandbox SHOULD provide a **session that persists
across calls** for a given account (a `putFile` then a later `exec`/`getFile` MUST address the
same working tree).

### 5.2 FileSystem (storage)
```
read(path: string) -> bytes?
write(path: string, data: bytes|string, opts?: { public?: bool }) -> { path, url? }
list(prefix?: string) -> string[]
publicUrl(path: string) -> string
```
When `opts.public` is set, `write` MUST return a `url` that resolves the object publicly (the CDN
URL). `publicUrl` MUST be deterministic for a given path.

### 5.3 SDK Injection (composed)
```
runWithSdk(code: string) -> { stdout: string, stderr: string, exitCode: int }
```
SDK Injection is not a new primitive interface; it is a **composition** of the Sandbox (§5.1), the
contract SDK derived from the registry (§6), and a scoped credential (§7.1). It runs caller-supplied
`code` inside the Sandbox with the SDK pre-installed and pre-authed, so the code can call back into
the gateway as the caller. The mechanism is standard module resolution: the implementation writes the
SDK bundle to `node_modules/<sdk>/` (with a matching `package.json` `main`) so `import` resolves with
no install, writes the code, and runs it with the credential supplied via environment.

A conforming implementation MUST:
- inject a **short-lived credential aliased to the calling account** (§7.1), never a long-lived or
  bearer-of-record secret, so the executing code holds no durable key;
- meter every call the injected SDK makes **to the calling account** (resolve the alias before
  metering, §7.3), at each operation's own cost;
- forbid recursion: a request authenticated by an injected (aliased/session) credential MUST NOT be
  able to invoke `runWithSdk` (or an Agent run, §5.1-informative) again, so injected code cannot
  spawn unbounded nested sandboxes (§8).

The credential's reserved `scopes` (§7.1) MAY narrow what the injected code can reach; an empty scope
set grants the caller's full capability surface.

## 6. Operations and the typed contract

The contract is a set of named **operations**. Each operation declares a method, a path, an input
schema, an output schema, and a **credit cost** (0 = free). The gateway exposes each operation as
an HTTP endpoint (§7) and applies the same pipeline to all of them (§4). A conforming
implementation MUST expose, at minimum, one operation per reference capability method in §5, plus the
account-facing `balance` and `events` operations (§7).

This registry is the **single source of truth**: server routing, client SDKs, and any published
OpenAPI description derive from it. Adding or changing operations is §10.

The workstation models no work-state and no task lifecycle: sequencing, retries, approval, and
"done"-ness are the Agent's concern.

## 7. Gateway HTTP API

All paths are relative to the deployment base URL. Bodies are JSON; binary fields are base64.
Every operation is gated identically: authenticate (§7.1) → rate limit (§7.5) → meter (§7.4) →
validate input → run → record an event (§7.3).

| Method & path | Primitive / purpose | Success | Errors |
|---|---|---|---|
| `POST /v1/sandbox/exec` | Sandbox: run a command | `200` ExecResult | `400`,`401`,`402`,`429` |
| `PUT /v1/sandbox/files` | Sandbox: write a file (base64) | `200` `{ path }` | `400`,`401`,`402`,`429` |
| `GET /v1/sandbox/files?path=` | Sandbox: read a file (base64) | `200` `{ data? }` | `401`,`402`,`429` |
| `POST /v1/sandbox/dispose` | Sandbox: suspend/destroy the VM | `200` `{ ok }` | `401`,`429` |
| `POST /v1/sandbox/run-with-sdk` | SDK Injection: run code with the pre-authed SDK (§5.3) | `200` ExecResult | `400`,`401`,`402`,`403`,`429` |
| `PUT /v1/fs/objects` | FileSystem: write object (base64) | `200` `{ path, url? }` | `400`,`401`,`402`,`429` |
| `GET /v1/fs/objects?path=` | FileSystem: read object (base64) | `200` `{ data? }` | `401`,`402`,`429` |
| `GET /v1/fs/list?prefix=` | FileSystem: list paths | `200` `{ paths }` | `401`,`429` |
| `GET /v1/fs/public-url?path=` | FileSystem: public CDN url | `200` `{ url }` | `401`,`429` |
| `GET /v1/balance` | Account: credit balance | `200` Balance | `401` |
| `GET /v1/events` | Account: recent usage events | `200` `{ events }` | `401` |

### 7.1 Authentication
Every request MUST carry `Authorization: Bearer <key>`. Each key resolves to an **account**;
requests without a key that resolves MUST receive `401`. The Provider (the single-node operator)
mints and distributes keys and owns their permissions. Each account has a **credit balance**;
billable calls debit it and an empty balance MUST return `402` (§7.4). There is no single shared
gateway key, and the protocol defines **no bypass/admin tier** — billing applies uniformly. An
operator who wants free or privileged access does so by their own means (e.g. zero per-op cost, a
large balance, or logic layered on the reserved per-account `scopes` field); that is out of scope
for the protocol.

### 7.2 Observability and events
The gateway MUST record an event for every gated call — at least `{ accountId, op, costCents,
status, ts }` — and expose an account's own events via `GET /v1/events`. This event ledger is the
workstation's unit of observability. Implementations MAY fan events
out to a Provider-configured webhook. Pull (`GET`) and push (event/webhook) are the only
interaction patterns.

### 7.3 Payment (metering)
Each operation has a credit cost (0 = free; costs live in the operation registry, §6). The gateway
MUST debit the cost atomically before performing the work and MUST refund it if a vendor-touching
step fails. When the balance cannot cover the cost the gateway MUST return `402 Payment Required`
with an RFC 7807 `application/problem+json` body carrying `required`, `balance`, and a `topupUrl`,
and SHOULD include a `WWW-Authenticate: Payment` header so a payment-capable agent (e.g. MPP /
x402) can settle inline. Metering applies to every account uniformly (no bypass tier).

Credits are *added* to a balance through one server-side seam (e.g. `accounts:grantCredits`); the
protocol defines the seam, **not** the purchase rail. How credits are bought — Stripe checkout,
agent-native x402 / MPP settlement, a subscription-style monthly grant, or a manual top-up — is the
Provider's choice and out of scope here. A conforming implementation MUST expose a way to add
credits to an account and MUST NOT make that path reachable by the spending caller itself.

The reference implementation ships **Stripe** as that rail (informative): a `POST /v1/topup`
Checkout op and a signature-verified `POST /webhooks/stripe` handler that calls the grantCredits
seam on `checkout.session.completed`. It is env-gated (`STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`)
and swappable — the protocol stays rail-neutral.

### 7.4 Rate limiting (abuse protection)
Independently of credits, a Provider MAY rate-limit calls to protect against abuse. The reference
implementation ships a fixed-window framework (per `(account, operation)` per minute) that is
**off by default** and enabled by the operator. When a caller exceeds the limit the gateway MUST
return `429 Too Many Requests` with a `Retry-After` header. Rate limiting is checked **before**
metering, so a throttled call does not consume credits.

## 8. Security considerations

- **Secrets are never a primitive.** Vendor credentials MUST be held server-side and MUST NOT be
  exposed through any primitive or endpoint. The Agent borrows capabilities (send, compute, store), never the underlying keys.
- **Sandbox isolation.** Unrestricted execution MUST be isolated from the Principal's real
  accounts.
- **Self-crediting.** The credit-grant seam (§7.3) MUST NOT be reachable by the spending caller.
- **Injected credentials are short-lived and aliased.** The credential placed in an SDK-injected
  sandbox (§5.3) MUST be a short-lived key aliased to the caller's account, holding no balance of its
  own; metering resolves through the alias to the caller. A long-lived or bearer-of-record key MUST
  NOT be exposed to executing code.
- **No nested injection.** A request authenticated by an injected (aliased/session) credential MUST
  NOT be able to start another SDK-injected sandbox or Agent run, bounding recursion (§5.3).
- **Scheduling, memory, and task tracking are out of scope.** They belong to the Agent (the
  brain), not the workstation; an implementation MUST NOT need them to conform.

## 9. Extensibility

The reference capabilities are a starting set, not the ceiling. New operations (a new method on a
capability, or a new capability such as `publish`) MUST be **additive** — a new entry in the
operation registry (§6) plus, for a new capability, a port + adapter — without changing existing
capability interfaces. Because the registry is the single source of truth, an added operation
surfaces in the server, the SDK, and any OpenAPI description from one definition. Breaking changes
to a capability interface or to §7 require a protocol version bump.

## 10. Reference adapters (informative)

These satisfy the interfaces above; any equivalent adapter conforms.

| Primitive | Reference adapter | Alternatives |
|---|---|---|
| Sandbox | Vercel Sandbox (persistent microVM) | Freestyle, E2B, Modal |
| Gateway / host | Convex (DB + HTTP actions) | any DB + HTTP server |

## 11. Reference deployment (informative)

The included implementation is **single-node, personal** (one Principal, no tenant model), hosted
on Convex:

- Convex is the **composition root + host**, not a primitive. HTTP actions front the contract; the
  gateway builds every route from the typed operation registry. Per-key **accounts** gate each
  call; the operator mints keys (e.g. `accounts:mintKey`), or clients self-serve via the public
  `POST /v1/signup` → `POST /v1/signup/claim` flow (a paid Stripe Checkout mints a key once).
- Vendor keys live in Convex environment variables, read server-side.
- Vendor SDKs require Node, so primitive calls run in a Convex `"use node"` action; the
  isolate-runtime gateway delegates to them.
- Compute = Vercel Sandbox (persistent, by-name; resumes the per-account working tree); storage = Cloudflare R2 via the S3 API (FileSystem +
  personal CDN). The event ledger and accounts/rate-limit counters are Convex tables. Convex's
  scheduler/vector/functions are deliberately **not** exposed as primitives (§8).

See [GETTING_STARTED.md](./GETTING_STARTED.md) to run it (including headless, no-login operation
via `CONVEX_AGENT_MODE=anonymous`).

---

## Glossary

- **Workstation** — the conforming backend; the gateway + reference capabilities, headless.
- **Agent / brain** — the external caller; bring your own. Owns task tracking.
- **Principal** — the customer.
- **Provider** — operator of a deployment (the Principal, when self-hosting); mints API keys.
- **Primitive / port** — one of the five interfaces (§5), extensible (§9).
- **Adapter** — a concrete implementation of a primitive (§10).
- **Gateway** — the deterministic spine: auth, metering, rate limits, events, routing.
- **Operation** — a named registry entry (method, path, input, output, cost) the gateway exposes.
