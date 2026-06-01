# Deployment Guide

Take a Workstation gateway from local dev to a live stack on
**Convex (API) + Cloudflare (R2 storage/CDN + DNS) + Vercel (static frontend)**, with custom
domains for both the API and the front door.

> **The one architectural rule:** the API is **pure Convex**. Every operation is served by Convex
> HTTP actions at `https://<deployment>.convex.site/v1/...` and consumed *directly* by the
> API / CLI / MCP / SDK. **Nothing about the API routes through Vercel.** Vercel hosts only the
> static `apps/web` front door (marketing + Stripe redirect pages), which makes **no** API calls.
> Keep the API and the frontend on **separate hostnames** and never add a Vercel→Convex rewrite —
> that separation is what guarantees the rule.

```
  agents / customers ──(API key)──►  https://api.example.com/v1/...      ← Convex HTTP actions (PURE CONVEX)
                                          │  reads & writes
                                          ▼
                                     Cloudflare R2  (durable blobs + CDN at cdn.example.com)

  humans (browser)   ─────────────►  https://example.com (Vercel, static apps/web)
```

| Layer | Host | Custom domain (example) |
|---|---|---|
| API (gateway HTTP actions) | Convex `*.convex.site` | `api.example.com` (prod), `api-dev.example.com` (dev) |
| Realtime/client (if used) | Convex `*.convex.cloud` | optional |
| Frontend (`apps/web`) | Vercel | `example.com` / `www` |
| Object storage + CDN | Cloudflare R2 | `cdn.example.com` |

---

## Prerequisites

- A **Convex account** — **Pro plan** is required for custom domains.
- A **Cloudflare account** with your domain's zone (DNS) hosted there, and R2 enabled.
- A **Vercel account** (frontend only).
- The provider keys listed in [`.env.example`](./.env.example) (Vercel Sandbox triple, R2, AI Gateway,
  Stripe, etc.). Each capability falls back to a mock adapter if its keys are absent.

---

## 1. Create the Convex project + environments (dev + prod)

You are logged in locally (`npx convex login`), so the CLI runs against your account. Create the
project plus a **cloud dev** deployment in one non-interactive step, then push the prod deployment:

```bash
# Dev (cloud) — creates the project, provisions a dev deployment, pushes code,
# and writes CONVEX_DEPLOYMENT / CONVEX_URL / CONVEX_SITE_URL to .env.local.
npx convex dev --once --configure new \
  --team <team-slug> --project <project> --dev-deployment cloud

# Prod — deploys schema + functions + crons to the project's production deployment.
npx convex deploy
```

Each deployment exposes two URLs:
- **API base (what clients hit):** `https://<deployment>.convex.site` ← the gateway / `convex/http.ts`
- Client/realtime URL: `https://<deployment>.convex.cloud`

> Switch a checkout between deployments anytime: `npx convex deployment select dev|prod|local`.

---

## 2. Environment variables (set once, inherited by both environments)

Convex env vars are **per deployment**, but **project defaults** are applied to every *new*
deployment of a given type. Set shared secrets as defaults for both `dev` and `prod` so they
propagate, and set them directly on the current dev deployment (defaults only apply to deployments
created *after* they're set):

```bash
# Shared secrets (repeat per var, or use --from-file with a .env file):
npx convex env set            R2_ACCOUNT_ID <id>                       # current dev deployment
npx convex env default set    R2_ACCOUNT_ID <id> --type prod --force   # prod inheritance
# (do the same for R2_ACCESS_KEY_ID/SECRET/BUCKET_NAME, CDN_BASE_URL, VERCEL_*, AI_GATEWAY_*,
#  STRIPE_SECRET_KEY, WORKSTATION_RATE_LIMIT_PER_MIN — everything in .env.example)
```

**Per-deployment URL vars** (these differ between dev and prod, so set them on each deployment, not
as a shared default):

| Var | Value |
|---|---|
| `WORKSTATION_API_URL` | this deployment's own API base — `https://<deployment>.convex.site` (or its custom domain, step 5). Used by the SDK injected into sandboxes to call back into the gateway. |
| `WORKSTATION_BASE_URL` | the public **frontend** URL (step 4) — used for Stripe success/cancel redirects and the 402 top-up CTA. |

```bash
npx convex env set        WORKSTATION_API_URL https://<dev-deployment>.convex.site   # dev
npx convex env set --prod WORKSTATION_API_URL https://<prod-deployment>.convex.site  # prod
```

Verify keylessly: `curl https://<deployment>.convex.site/v1/health` → backends should read
`vercel` / `r2` / etc. instead of `mock` once the keys are set.

---

## 3. Cloudflare R2 (object storage + CDN)

The FileSystem primitive and any durable-blob writes use R2 over the S3 API
(`endpoint: https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`, `region: "auto"`).

1. **Create a bucket** — Cloudflare → **R2** → *Create bucket* (e.g. `<project>-objects`).
   *(Also doable programmatically via `wrangler r2 bucket create`, the Cloudflare API, or the
   Cloudflare MCP — bucket CRUD only; the steps below are dashboard-only.)*
2. **Create an S3 API token** — R2 → *Manage R2 API Tokens* → *Create API Token*, permission
   **Object Read & Write**, scoped to the bucket. It returns the **Access Key ID** + **Secret**;
   your **Account ID** (the 32-char hex) is in the R2 overview sidebar — that's `R2_ACCOUNT_ID`
   (the account ID, not the token ID).
3. **Public delivery** (needed for the FileSystem primitive's public URLs and to serve blobs) —
   bucket → **Settings**: enable the **Public Development URL** (`pub-xxxx.r2.dev`) for testing, or
   connect a **Custom Domain** like `cdn.example.com` (Cloudflare provisions it with CDN caching).
4. **Wire it** (step 2 mechanism): `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_ACCESS_KEY_SECRET`,
   `R2_BUCKET_NAME`, and `CDN_BASE_URL=https://cdn.example.com`.

No CORS config is needed — uploads are server-side from Convex actions; public reads are plain GETs.

---

## 4. Vercel (static frontend, `apps/web`)

`apps/web` is a static Next.js front door (landing + Stripe `/success` + `/cancel`). It makes **no**
API calls, so it needs no client secrets and no proxy.

1. **vercel.com → New Project → Import** the repo.
2. **Root Directory = `apps/web`** ← required for the monorepo (framework auto-detects Next.js). If
   install fails on workspace deps, enable *"Include files outside the root directory"*.
3. **Environment variables: none.**
4. **Deploy** → note the URL (e.g. `https://<project>.vercel.app`).
5. Point Stripe redirects + the 402 CTA at it (step 2): set `WORKSTATION_BASE_URL` on dev + prod.
6. **Do NOT** add a `vercel.json` rewrite to `*.convex.site`. Clients hit Convex directly.

---

## 5. Custom domains

Map your domain so the **API** lives on Convex subdomains and the **frontend** on Vercel — never the
same hostname.

### 5a. Convex API → `api.example.com` (prod) and `api-dev.example.com` (dev)

Custom domains are configured **per deployment** (so dev and prod each get their own) on the
**Deployment Settings** page, and require the **Convex Pro** plan.

For **each** deployment (do prod with `api.example.com`, dev with `api-dev.example.com`):

1. Convex dashboard → open the deployment → **Settings** → the custom-domains section.
2. Add your domain to the **HTTP Actions URL** (`.convex.site`) — this is the gateway/API surface
   that serves `convex/http.ts`. (You can optionally also map the **Convex/client URL** `.convex.cloud`
   if you use the realtime client; the gateway API only needs the `.site` mapping.)
3. Convex shows the **DNS records** to add. In **Cloudflare → DNS**, create them exactly as shown —
   typically a **CNAME** for the subdomain pointing to the Convex-provided target. Set it
   **DNS only (grey cloud)** so Convex terminates TLS directly and the request is **not** proxied
   through Cloudflare (keeps the API purely Convex).
4. Convex verifies in the background (green checkmark) and **auto-mints the TLS certificate**; the
   first request can take up to ~1 minute.
5. Update `WORKSTATION_API_URL` to the branded URL on that deployment:
   ```bash
   npx convex env set --prod WORKSTATION_API_URL https://api.example.com
   npx convex env set        WORKSTATION_API_URL https://api-dev.example.com
   ```

Now `https://api.example.com/v1/...` (prod) and `https://api-dev.example.com/v1/...` (dev) serve the
gateway directly from Convex.

### 5b. Frontend → `example.com` / `www`

Vercel project → **Settings → Domains** → add `example.com` (and `www`). Vercel shows the records to
create; add them in **Cloudflare → DNS**. DNS-only is simplest; if you proxy (orange cloud), set
Cloudflare **SSL/TLS** mode to **Full (strict)**. Then update `WORKSTATION_BASE_URL` to the apex.

---

## 6. Verify

```bash
curl https://api.example.com/v1/health        # prod  → {sandbox, filesystem, ... not "mock"}
curl https://api-dev.example.com/v1/health     # dev
curl https://cdn.example.com/<a-known-key>     # R2 object served over the CDN domain (HTTP 200)
```

Mint keys and go: `npx convex run --prod accounts:mintKey '{"label":"customer","creditsCents":5000}'`.

---

## Notes

- **`npx convex deploy` (prod) is operator-run** — keep it a deliberate human step, not automation.
- **Crons** in `convex/crons.ts` start running automatically once deployed.
- **Billing:** set `STRIPE_SECRET_KEY` (+ `STRIPE_WEBHOOK_SECRET`) for self-serve top-ups, or grant
  credits manually with `accounts:grantCredits`.
- Full env reference: [`.env.example`](./.env.example).

**Source:** [Convex — Custom Domains](https://docs.convex.dev/production/custom-domains).
