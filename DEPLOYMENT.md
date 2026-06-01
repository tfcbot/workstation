# Deployment SOP

Deploy a Workstation gateway to production: **Convex (API) · Cloudflare (R2 + DNS) · Vercel (static frontend)**.

**Invariant:** the API is pure Convex — served from `*.convex.site`, called directly by API/CLI/MCP/SDK. Vercel serves only static `apps/web`. API and frontend stay on separate hostnames; never add a Vercel→Convex rewrite.

| Layer | Host | Domain | Cloudflare proxy |
|---|---|---|---|
| API (HTTP actions) | Convex `*.convex.site` | `api.example.com` (prod) / `api-dev.example.com` (dev) | grey (DNS only) |
| Frontend `apps/web` | Vercel | `example.com` / `www` | grey (DNS only) |
| Storage + CDN | Cloudflare R2 | `cdn.example.com` | orange (proxied) |

## Prerequisites
- Convex account (Pro plan required for custom domains); logged in via `npx convex login`.
- Cloudflare account hosting the domain's DNS zone; R2 enabled.
- Vercel account.
- Provider keys per [`.env.example`](./.env.example) (a missing key → that capability runs on its mock adapter).

## 1. Convex project + deployments
```bash
npx convex dev --once --configure new --team <team> --project <project> --dev-deployment cloud
npx convex deploy
```
- Cmd 1: creates the project + cloud dev deployment, pushes code, writes `CONVEX_*` to `.env.local`.
- Cmd 2: creates/pushes the prod deployment.
- API base per deployment: `https://<deployment>.convex.site`. Switch checkouts: `npx convex deployment select dev|prod|local`.

## 2. Environment variables
Set shared secrets on the dev deployment AND as prod defaults:
```bash
npx convex env set         <NAME> <value>
npx convex env default set <NAME> <value> --type prod --force
```
- Apply to every key in [`.env.example`](./.env.example) (`R2_*`, `CDN_BASE_URL`, `VERCEL_*`, `AI_GATEWAY_*`, `STRIPE_SECRET_KEY`, `WORKSTATION_RATE_LIMIT_PER_MIN`). Bulk load with `--from-file <env>`.
- Set per-deployment URL vars on each deployment (not as defaults):
  ```bash
  npx convex env set        WORKSTATION_API_URL https://<dev-deployment>.convex.site
  npx convex env set --prod WORKSTATION_API_URL https://<prod-deployment>.convex.site
  ```
- `WORKSTATION_BASE_URL` = public frontend URL — set after §4.
- Check: `curl https://<deployment>.convex.site/v1/health` → backends ≠ `mock`.

## 3. Cloudflare R2
S3 API: `endpoint=https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`, `region=auto`.
1. Create bucket `<project>-objects` (R2 → Create bucket; or `wrangler r2 bucket create`, REST API, or Cloudflare MCP `r2_bucket_create`).
2. Create S3 token: R2 → Manage R2 API Tokens → Create → **Object Read & Write**, scoped to the bucket → yields Access Key ID + Secret.
3. `R2_ACCOUNT_ID` = the 32-char account ID (R2 sidebar), not the token ID.
4. Public delivery: bucket → Settings → enable Public Dev URL (`pub-xxxx.r2.dev`) or connect `cdn.example.com` (proxied/orange).
5. Set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_ACCESS_KEY_SECRET`, `R2_BUCKET_NAME`, `CDN_BASE_URL` (§2). No CORS required.

## 4. Vercel — static frontend
1. Import repo → New Project.
2. Set **Root Directory = `apps/web`** (Next.js auto-detected).
3. Commit **`apps/web/vercel.json`** (required):
   ```json
   { "$schema": "https://openapi.vercel.sh/vercel.json", "framework": "nextjs", "buildCommand": "next build", "installCommand": "bun install" }
   ```
   Note: a root `turbo.json` makes Vercel auto-generate `cd apps/web && bun run build`, which fails against Root Directory `apps/web` (`cd: apps/web: No such file or directory`). Project-settings build command is overridden by Turbo detection; `apps/web/vercel.json` is authoritative. Commit it on the production branch.
4. No frontend env vars.
5. Deploy. Set `WORKSTATION_BASE_URL` = prod frontend URL (§2).
6. Do not add a `vercel.json` *rewrite* to `*.convex.site`.

Notes:
- Protection `all_except_custom_domains`: `*.vercel.app` URLs return `401`; custom domains are public.
- Programmatic path: `vercel` CLI, or REST (`POST /v10/projects` with `gitRepository`+`rootDirectory`, `POST /v13/deployments`, `POST /v10/projects/{id}/domains`) with `VERCEL_TOKEN`. Confirm DNS via `GET /v6/domains/{domain}/config` → `misconfigured:false`.

## 5. Custom domains

### 5a. Convex API — per deployment (Convex Pro)
1. Convex dashboard → deployment → Settings → Custom Domains → add the domain to the **HTTP Actions URL** (`.convex.site`): `api.example.com` (prod), `api-dev.example.com` (dev).
2. Cloudflare → DNS: add the CNAME Convex shows, **grey cloud**.
3. Convex auto-mints TLS (first request ≤ ~1 min).
4. Set `WORKSTATION_API_URL` to the custom domain on that deployment (§2).

### 5b. Frontend
1. Add `example.com` + `www.example.com` in Vercel (Settings → Domains, or `POST /v10/projects/{id}/domains`). Auto-verifies unless the domain is on another Vercel account.
2. Cloudflare → DNS, **grey cloud** (apex CNAME is flattened):

   | Type | Name | Target |
   |---|---|---|
   | CNAME | `@` (`example.com`) | `cname.vercel-dns.com` (or the `<hash>.vercel-dns-NNN.com` Vercel shows) |
   | CNAME | `www` | same target |

3. Vercel auto-mints TLS (~1 min; HTTPS returns `000` until the cert is ready, then `200`).
4. Set `WORKSTATION_BASE_URL` = apex (§2).

## 6. Verify
```bash
curl -s  https://api.example.com/v1/health      # prod  → backends ≠ "mock"
curl -s  https://api-dev.example.com/v1/health  # dev
curl -sI https://cdn.example.com/<key>          # R2 via CDN → 200
curl -sI https://example.com                    # frontend → 200, server: Vercel
npx convex run --prod accounts:mintKey '{"label":"customer","creditsCents":5000}'
```

## Operational notes
- `npx convex deploy` (prod) is run manually by an operator.
- Crons in `convex/crons.ts` run automatically after deploy.
- Vercel auto-deploys the production branch (Settings → Git); keep `apps/web/vercel.json` on it.
- Billing: set `STRIPE_SECRET_KEY` (+ `STRIPE_WEBHOOK_SECRET`) for top-ups, or grant credits via `accounts:grantCredits`.

Refs: [Convex Custom Domains](https://docs.convex.dev/production/custom-domains) · [Vercel Monorepos](https://vercel.com/docs/monorepos) · [vercel.json](https://vercel.com/docs/project-configuration).
