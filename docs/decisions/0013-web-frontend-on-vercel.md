# 0013 — Hosted web frontend on Vercel

Status: accepted (2026-10-03, #123). Implementation: #155–#161.

## Context

Across Lab80 projects, frontends run on Vercel and APIs and databases on
Railway. The hosted netrics web app (Next.js, `apps/web`) instead runs on
Railway as `ghcr.io/netrics-so/web`, the same signed image self-hosters run.
CLAUDE.md states the invariant: "One image for SaaS and self-hosting:
nothing environment-specific at build time." On Vercel the hosted frontend
would be built from source.

What the web app does today, and what a move has to keep:

- **Same-origin proxy (ADR 0005).** The browser talks only to the web
  origin. Route handlers proxy `/v1/*` and `/api/auth/*` to the API
  (`lib/api-proxy.ts`), and server components call the API directly; all of
  them read `NETRICS_API_URL` per request. On Railway that is the private
  network. Request bodies are buffered and capped at 1 MiB, the API's own
  limit. (ADR 0005 still says the API URL is a build argument baked in by
  rewrites. That is out of date; `docs/release.md` describes the current
  per-request behaviour.)
- **Client IP.** The proxy drops client-sent `forwarded`, `x-forwarded-for`
  and `x-real-ip`, works out the client address (`NETRICS_TRUSTED_PROXY_HOPS`
  from the right of `X-Forwarded-For`, or one header named by
  `NETRICS_CLIENT_IP_HEADER`) and forwards it as `x-forwarded-for` and
  `x-real-ip`. The API believes forwarded addresses only from hops in
  `NETRICS_TRUSTED_PROXIES` (default: loopback and private ranges), and keys
  the auth rate limits (`auth/rate-limit.ts`, e.g. sign-in 10 per minute) and
  the pairing limit (ADR 0011, 10 per 10 minutes) on that address.
- **Host handling (ADR 0010, `proxy.ts`).** With `NETRICS_APP_ORIGIN` set,
  requests on any other host get a 308 to the same path on the app origin,
  except `/healthz`, `/v1/server`, `/v1/device/*`, `/kiosk` and `/_next/*`.
  `NETRICS_PAIRING_HOST` sends a pairing host to the approval page. The Host
  header is used as received; no forwarded-host header is trusted. Without
  the variables nothing is redirected.
- **Health and versions.** `/healthz` returns `ok` with no dependencies (the
  platform probe and the release smoke check). The API reports version and
  commit on `/health/live`. The web version and commit are build-time
  `NEXT_PUBLIC_APP_VERSION` and `NEXT_PUBLIC_GIT_SHA`, read only in server
  components (`/status`, `/kiosk`). They identify the commit and are not
  environment-specific. No `NEXT_PUBLIC_*` value reaches browser code (the
  auth client is same-origin).
- **Security headers.** `next.config.ts` sets a strict CSP (`default-src
'self'`, `connect-src 'self'`, `form-action 'self'`, `frame-ancestors
'none'`) and related headers.
- **OAuth (ADR 0012).** The callback `/oauth/<provider>/callback` is a thin
  web route that forwards the query and session cookie to the API through
  `NETRICS_API_URL`. The redirect URI is derived from `WEB_ORIGIN`.
- **Releases (`docs/release.md`).** Each `main` commit is built once into
  signed images and dispatched to the private deploy repository. That
  repository runs migrations as the API's pre-deploy step, rolls out API, then
  web, then worker and scheduler, health-gates each step, smoke-checks, and
  records the digests. Rollback redeploys recorded digests. Tags promote
  existing digests for self-hosters (`promote.yml`).
- **Clients.** The tvOS app's hosted server is `https://app.netrics.so`
  (`ServerConfig.swift`). TVs and browser kiosks reach the device API through
  the web origin. netrics.tv is already a separate Vercel site that redirects
  pairing codes to the app origin.

## Decision

**Build the hosted web frontend on Vercel from the same commit (option B).**
The private release workflow, triggered by the existing dispatch, builds
`apps/web` from the dispatched commit and deploys it as a staged production
deployment, promoted once the API is healthy at that commit. The API, worker
and scheduler stay signed images on Railway. Self-hosters keep running the
signed images, web included.

In summary:

1. **Invariant: one source, same commit.** It replaces "one image for SaaS
   and self-hosting" (wording below).
2. **The API stays public.** It is not restricted to frontend traffic.
   Sessions and tokens protect it as today (ADR 0009 principals, ADR 0011
   device credentials), so token clients (integrations, scripts, a future
   MCP server) can call it. The shared secret `NETRICS_PROXY_SECRET` only
   marks requests from the frontend, so the API can trust the client IP they
   forward.
3. **Dedicated hosts.** Browsers keep using `app.netrics.so`. Token clients
   use `api.netrics.so`. `mcp.netrics.so` is reserved for a future MCP
   server. The hosts may route to the same service at first; separate names
   leave room for a load balancer or a split later. Self-hosters may keep one
   origin.
4. **Region `fra1`**, the closest Vercel region to the API's Railway region
   (Amsterdam). Latency is checked once after the switch; there is no formal
   gate.
5. **Direct cut-over.** There are no users yet, so DNS switches directly,
   the result is verified, and the Railway web service is removed. There is
   no warm rollback window or parallel running.
6. **Vercel Pro features.** Skew protection is on. No longer `maxDuration`
   than the default, and no Static IPs.

### The invariant

CLAUDE.md now reads:

> One source, same commit: nothing environment-specific at build time.
> Self-hosters run the signed images. The hosted service runs the same server
> image and builds the web frontend on Vercel from the same commit and
> lockfile, with configuration read at request time. A CI build guard checks
> that the web build has no environment-specific inputs.

The guarantees behind it:

1. **Same commit.** The build checks out the dispatched SHA, the commit
   whose images were just published. Git-triggered Vercel deployments are
   off, so no other commit or branch can reach production, and there are no
   automatic preview deployments.
2. **Same lockfile and toolchain.** `pnpm install --frozen-lockfile` with
   the pinned pnpm (`packageManager`), Node 24 (ADR 0003), and the same
   `pnpm --filter @netrics/web... build` as the Dockerfile.
3. **No environment-specific build inputs.** The build gets exactly two
   variables, `NEXT_PUBLIC_APP_VERSION` and `NEXT_PUBLIC_GIT_SHA`, with the
   same values as the image's build arguments. It runs in CI with
   `vercel build` and `vercel deploy --prebuilt`, not on Vercel's builders
   with project environment variables, so no `NETRICS_*` value is present
   at build time. Everything environment-specific stays runtime
   configuration, as in the image (`NETRICS_API_URL`, `NETRICS_APP_ORIGIN`,
   `NETRICS_CLIENT_IP_HEADER`, `NETRICS_PROXY_SECRET`), set in the Vercel
   project's production environment.
4. **A CI guard (#160).** The web app is built twice, with and without
   sample `NETRICS_*` values, and the check fails if the outputs differ. This
   catches a module-scope `process.env` read, or a page that turns static and
   captures configuration.
5. **Runtime injection stays.** No new `NEXT_PUBLIC_*` variable is
   introduced for configuration.

What it does not guarantee: Vercel's Next.js output (functions, routing
middleware, CDN assets) differs from `output: "standalone"`, so the hosted
frontend is not bit-for-bit the self-hosted one and has no image digest or
signature. Its identity is the Vercel deployment ID, bound to the commit.

### Web → API

`NETRICS_API_URL` becomes the API's public HTTPS address
(`https://api.netrics.so`). Traffic leaves Railway's private network and is
TLS-encrypted. With the function region in `fra1`, a few milliseconds per
API call are expected; fluid compute reuses instances, so connections stay
warm. One shared fetch helper (#155) carries every web→API request: the
proxy (`/v1/*`, `/api/auth/*`), server components, `/status` and the OAuth
callback.

### Proxy secret and client IP (#156)

Vercel overwrites `x-forwarded-for` with the visitor's address;
`x-vercel-forwarded-for` carries the same address and cannot be replaced by
a proxy in front of Vercel
([request headers](https://vercel.com/docs/headers/request-headers)). The
web app uses the existing `NETRICS_CLIENT_IP_HEADER=x-vercel-forwarded-for`.

At the API, the request arrives from a dynamic Vercel egress address through
Railway's edge, so `request.ip` would be one address shared by all users,
and the auth rate limits (sign-in 10 per minute) and the pairing limit
(ADR 0011) would apply to everyone together. Therefore:

- `NETRICS_PROXY_SECRET` (unset by default, so self-hosting is unchanged) is
  set on the web app and the API. The web sends it in
  `x-netrics-proxy-secret` together with the resolved client address in
  `x-netrics-client-ip`, after dropping client-supplied values of both. It
  sends the address only if it is a single valid IP.
- The API uses `x-netrics-client-ip` only on requests with a valid secret
  (timing-safe comparison, two values accepted during rotation) and a valid
  IP. Every other request uses `request.ip` from its own trusted-proxy logic
  (`NETRICS_TRUSTED_PROXIES`), as today. The rate-limit bridge and the
  pairing route read this one resolved value.
- **The secret never gates access.** A request without it is served like
  any other and authenticated by its session or token. Restricting the API
  to the frontend was considered and rejected: it would lock out token
  clients, and the API's own authentication already protects every route.
- **Cookie sessions only through the frontend.** With the secret set, the
  API accepts session cookies only on requests that carry it. Browsers only
  ever reach the API through the web origin, so this changes nothing for
  them. It makes "cookies on the web origin, bearer tokens on the API host"
  an enforced rule rather than a convention.

Alternatives for authenticating the frontend: mTLS is not possible (Railway's
edge terminates TLS); IP allowlisting would need Vercel Static IPs plus an
application check, because Railway has no ingress firewall. The secret
header is simpler, and Vercel documents the same pattern.

### Hosts

| Host             | Clients                                   | Auth                           |
| ---------------- | ----------------------------------------- | ------------------------------ |
| `app.netrics.so` | Browsers, TVs, browser kiosks (via proxy) | Session cookies, device tokens |
| `api.netrics.so` | Integrations, scripts, service accounts   | Bearer tokens (ADR 0009/0011)  |
| `mcp.netrics.so` | Reserved for a future MCP server (#159)   | To be decided with its design  |
| `netrics.tv`     | Pairing redirect (separate Vercel site)   | None                           |

What `api.netrics.so` implies (#158):

- **Cookies.** Better Auth sets host-only cookies on `app.netrics.so`, so
  browsers never send them to the API host. Together with the cookie rule
  above, there is no cookie authentication on `api.netrics.so`, and so no
  CSRF surface there.
- **CORS.** It stays limited to `WEB_ORIGIN` with credentials. The API host
  gets no credentialed CORS. Calls from browsers on other origins are not a
  supported client for now; token clients are server-side.
- **Surface.** `/v1/*` and `/health/*`. `/api/auth/*` is a browser flow and
  is not part of the API host's documented surface. OpenAPI lists
  `https://api.netrics.so` as the hosted server URL.
- **Devices and kiosks** keep using the web origin. The tvOS app's hosted
  server stays `https://app.netrics.so` (`ServerConfig.swift`), and nothing
  changes for paired TVs. Moving device polling to the API host would save
  Vercel invocations, but it needs a separate API base in the app, so it is
  a later option, not part of this decision.
- **Self-hosters.** The separation is optional. One origin with the web
  proxy keeps working; a separate API host needs only DNS and the API's
  port. Without `NETRICS_PROXY_SECRET`, nothing changes.

### Host redirects, `/healthz`, CSP

- **Host redirects.** `proxy.ts` runs as Vercel routing middleware.
  `NETRICS_APP_ORIGIN=https://app.netrics.so` is set for production only, so
  generated `*.vercel.app` URLs redirect to the app origin except the exempt
  paths. `NETRICS_PAIRING_HOST` stays unset (netrics.tv is its own site). To
  verify on the first deployment: `process.env` is populated at request time
  in the middleware runtime. If it is not, configuration is read through an
  explicit allowlist of names.
- **`/healthz` (#157)** stays dependency-free and also reports the version
  and commit (`{"status":"ok","version":…,"commit":…}`), so the smoke check
  confirms the web commit on both platforms. Probes check only the status
  code.
- **CSP and security headers** come from `next.config.ts` `headers()`, which
  Vercel applies. Nothing that injects scripts is enabled (Toolbar, Web
  Analytics, Speed Insights). Skew protection needs no CSP change.
- **Cookies and OAuth.** The origin does not change, so sessions,
  `WEB_ORIGIN`, `BETTER_AUTH_URL`, the Origin checks and the OAuth redirect
  URI `<WEB_ORIGIN>/oauth/<provider>/callback` (ADR 0012) all stay valid. No
  provider console needs an update.

### Releases

- **Build.** The private workflow checks out the dispatched commit, runs
  `vercel build` with only the two `NEXT_PUBLIC_*` values, and
  `vercel deploy --prebuilt --prod --skip-domain`. It records the deployment
  ID beside the image digests. This can run in parallel with the API
  deployment.
- **Order.** The API deploys first, with migrations as its pre-deploy step.
  Once `/health/ready` reports the candidate commit, the staged web
  deployment is checked on its deployment URL (`/healthz` reports the
  candidate commit) and promoted with `vercel promote`. Worker and scheduler
  follow. Expand/migrate/contract keeps the old frontend working against the
  new API during the window.
- **Smoke.** It checks the commits on the API's `/health/live` and on
  `https://app.netrics.so/healthz`, and loads `/status`.
- **Rollback.** `release/production.yaml` records the image digests and the
  web deployment ID together. Rolling back redeploys the previous digests on
  Railway and promotes the previous Vercel deployment (instant, no rebuild).
- **Self-hosters.** Unchanged: `release.yml` builds, signs and attests both
  images, `promote.yml` tags digests, and Compose runs the web image. The web
  image stays a released artifact, tested in CI and in the `selfhost` check.
- **Skew protection** is on. To verify with prebuilt deployments: assets
  requested by an open tab are served from its own deployment across a
  release.

### Limits and costs

- **Duration.** The default function duration (300 s with fluid compute) is
  ample; netrics has no streaming or long-held requests. The proxy routes set
  a shorter `maxDuration`, so a hung API call ends in a clear 504.
- **Body size.** Vercel functions accept at most 4.5 MB of request and
  response body. The 1 MiB proxy cap on requests stays the binding limit.
  Responses are paginated; the largest (observations, metric queries) must
  stay well under 4.5 MB.
- **Cost.** Every proxied request is a function invocation, billed by active
  CPU and memory time. TV and kiosk polling is the steady part and grows with
  the number of screens. A later option: serve `/v1/*` through a Vercel
  external rewrite with the secret added by a header transform, or move
  device polling to `api.netrics.so`.

### Cut-over plan (#161)

1. Ship #155, #156, #157 and #160 and deploy them on Railway, with the secret
   set on both services. Add `api.netrics.so` to the API service.
2. Create the Vercel project in the private infrastructure repository (Git
   deployments off, region `fra1`, skew protection, production variables,
   deployment protection for generated URLs), and extend the private release
   workflow to build, stage and promote.
3. Add `app.netrics.so` to the Vercel project and
   [pre-generate its certificate](https://vercel.com/docs/domains/pre-generating-ssl-certs),
   so the switch has no window without a valid certificate. Check the staged
   deployment with `curl --resolve`: headers, host redirects, `/healthz`.
4. Switch the `app.netrics.so` record to Vercel.
5. Verify on the live domain: sign-in, a dashboard, `/status`, the client
   address the API sees on a failed sign-in, the OAuth callback, the
   netrics.tv redirect and pairing, a TV and a kiosk refreshing, a token
   client on `api.netrics.so`, and the added latency from `fra1` (recorded
   once).
6. Remove the Railway web service, and update `docs/release.md`, ADR 0005
   and the remaining docs that describe the hosted web on Railway.

If verification fails, the record points back at the Railway web service
until it is removed; with no users, a short outage is acceptable.

## Alternatives considered

- **A. Keep the web image on Railway.** The invariant holds in its strongest
  form, and web→API stays on the private network. Rejected for platform
  consistency (all Lab80 frontends run on Vercel), the CDN for static assets,
  and Vercel's firewall in front of the auth endpoints.
- **C. Vercel as a CDN in front of the Railway web container** (external
  rewrites). It keeps the image but adds a hop to every request, gains
  nothing for dynamic pages, pays both platforms, and needs a new two-edge
  client-IP trust setup. Not worth the complexity.
- **D. The signed web image as a Vercel container function**
  ([Container Images](https://vercel.com/docs/functions/container-images)).
  It keeps the digest invariant, but it is beta, scales to zero after
  5 minutes (container cold starts), and loses the Next.js integration (CDN
  for `/_next/static`, routing middleware, skew protection). Worth
  revisiting when it is generally available, if the signed digest matters
  more than that integration.

## Consequences

- CLAUDE.md's invariant becomes "one source, same commit". The web image
  remains a signed release artifact for self-hosters, but the hosted service
  no longer runs it.
- The API gains an optional proxy secret, authenticated client-IP
  forwarding, and secret-gated cookie sessions. They are useful to
  self-hosters who put the web app and API on different hosts.
- The API's public address becomes load-bearing for the frontend and is
  documented for token clients at `api.netrics.so`.
- The private release workflow deploys to two platforms and records one more
  identifier per release. Hosted web rollbacks are Vercel promotions.
- The hosted frontend gets Vercel's CDN, firewall and DDoS protection, and
  the same operations model as other Lab80 frontends.
