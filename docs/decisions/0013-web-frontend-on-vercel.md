# 0013 — Hosted web frontend on Vercel

Status: proposed (2026-10-02, #123). Not accepted: the open questions at
the end need a decision first.

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

## Options

### A. Keep the web image on Railway

Nothing changes. The invariant holds in its strongest form: production runs
the signed digest that self-hosters can verify. Web→API stays on the private
network (plain HTTP inside Railway, low latency, no API exposure needed for
the web's sake), and the client-IP setup is already verified on Railway.

Cost: the hosted frontend is the one Lab80 frontend not on Vercel. There is
no CDN for static assets, no Vercel firewall in front of the auth endpoints,
and one more Railway service to run.

### B. Build the hosted frontend on Vercel from the same commit

The private release workflow, triggered by the existing dispatch, builds
`apps/web` with the Vercel CLI from the dispatched commit and deploys the
result as a staged production deployment. It is promoted only after the API
is healthy at that commit. Self-hosters keep the image.

The guarantees that make "same source" mean something:

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
   configuration, as in the image: `NETRICS_API_URL`, `NETRICS_APP_ORIGIN`,
   `NETRICS_CLIENT_IP_HEADER` and so on, set in the Vercel project's
   production environment. (On Vercel, changing a variable takes effect with
   the next deployment, much as a Railway variable change redeploys.)
4. **A CI guard.** A check in this repository builds the web app twice, with
   and without sample `NETRICS_*` values in the environment, and fails if
   the client bundles differ. This catches a module-scope `process.env`
   read, or a page that turns static and captures configuration.
5. **Runtime injection stays.** No new `NEXT_PUBLIC_*` variable is
   introduced for configuration. Browser code keeps learning nothing from
   the build.

What it does not guarantee: Vercel's Next.js builder produces a different
output from `output: "standalone"` (functions, routing middleware, CDN
assets), so the hosted frontend is not bit-for-bit the self-hosted one, and
there is no image digest or signature for it. Vercel's deployment ID, bound
to the commit, is its identity. The invariant would be reworded for the web
app, for example:

> One source for SaaS and self-hosting: nothing environment-specific at
> build time. Self-hosters run the signed images. The hosted service runs
> the server image, and builds the web frontend on Vercel from the same
> commit and lockfile, with configuration read at request time.

### C. Vercel as CDN or edge in front of the Railway web container

The Vercel project only serves external rewrites of everything to the
Railway web service (the
[reverse-proxy pattern](https://vercel.com/docs/routing/rewrites#rewrites-to-external-origins)).
The image invariant stays whole, and Vercel adds a CDN, its firewall and
DDoS protection.

Honest assessment: it adds a hop to every request, and dynamic pages (almost
all of netrics) gain nothing from a CDN. It keeps all of Railway's running
costs and adds Vercel's. The Railway web service needs a public domain, and
must reject traffic that bypasses Vercel (Vercel's documented
secret-header transform). The client IP passes through two edges (Vercel,
then Railway, which appends its own nodes), so the web app would need a new
trust setup. This is a fronting proxy, not the Lab80 pattern; it does not
justify its complexity.

### D. Run the signed web image on Vercel as a container function

Vercel Functions can run OCI images
([Container Images](https://vercel.com/docs/functions/container-images),
beta on all plans), stored in Vercel Container Registry. The release could
copy the signed digest from GHCR to VCR and deploy it, keeping the invariant
fully: the same digest runs everywhere.

Against it for now: it is beta. Instances scale to zero after 5 minutes
without traffic, so a quiet instance pays a Next.js container cold start. It
gets none of the Next.js integration (CDN for `/_next/static`, routing
middleware, skew protection), and Static IPs are not supported with
container images. Worth revisiting when the feature is generally available,
if the image invariant matters more than the Next.js integration.

## Proposed decision

**Option B**, gated on the prerequisites below. All of them are code in this
repository and work for every topology, not only Vercel. The web service
stays on Railway until they ship.

### Web → API over the public internet

`NETRICS_API_URL` becomes the API's public HTTPS address on Railway (the
API already has one, used for health checks and smoke tests). The traffic is
TLS-encrypted, which the private-network hop was not.

**Latency (reasoned, not measured).** Each page render makes several
server-side API calls (session check plus data), some in sequence. Today
each is a private-network round trip of about a millisecond. On Vercel each
call crosses the public internet and Railway's edge. Two rules keep this
small:

- Pin the function region to the Railway region the API runs in, or the
  nearest one (Railway US East and Vercel `iad1` are both in northern
  Virginia; Railway's EU region, in the Netherlands, is a few milliseconds
  from `fra1`, `lhr1` or `cdg1`). The Vercel default is `iad1`; an EU API
  behind a US function would add roughly 80–100 ms to _every_ sequential
  call. This is a deliberate project setting
  ([function regions](https://vercel.com/docs/functions/configuring-functions/region)).
- Fluid compute reuses instances, so connections to the API stay warm (Node
  `fetch` keep-alive). A cold instance pays a TLS handshake once.

Expect a few milliseconds per call with co-located regions. Measure on a
non-production deployment against a non-production API before cutover; a
budget of under 10 ms added per API call at p50 is a reasonable gate.

**The API accepts only the frontend (shared secret).** A new
`NETRICS_PROXY_SECRET` (unset by default, so self-hosting is unchanged) is
set on the web app and the API:

- Every web→API request, whether proxied (`/v1/*`, `/api/auth/*`), from a
  server component, or the OAuth callback, sends it in
  `x-netrics-proxy-secret` through one shared fetch helper. The proxy drops
  any client-supplied value first.
- With the secret set, the API refuses requests without a matching value
  (timing-safe comparison, two values accepted during rotation), except
  `/health/live` and `/health/ready` for platform probes and smoke checks.
  This hides the API surface from direct traffic. Nothing legitimate
  bypasses the web origin today: browsers, TVs and kiosks all use
  `app.netrics.so`.
- Alternatives: mTLS is not possible, because Railway's edge terminates TLS
  and does not pass client certificates. IP allowlisting would need Vercel
  [Static IPs](https://vercel.com/docs/networking/static-ips) (Pro, a fixed
  monthly fee per project, a pool shared with other Vercel customers, and
  not applied to routing middleware), plus an application-level check,
  because Railway has no ingress firewall. A secret header is simpler and
  stronger. Vercel documents the same pattern for protecting origins.

**Device API and kiosk.** They keep calling the web origin; the proxy adds
the secret like any other proxied request. Nothing changes for paired TVs.
The device API's request volume (TV and kiosk polling) becomes function
invocations on Vercel; see costs.

### Client IP behind Vercel

Vercel overwrites `x-forwarded-for` with the visitor's address and does not
forward client-supplied values. `x-real-ip` and `x-vercel-forwarded-for`
carry the same address. `x-vercel-forwarded-for` is the one a proxy placed
in front of Vercel cannot replace
([request headers](https://vercel.com/docs/headers/request-headers)). The
web app is configured with the existing variable:
`NETRICS_CLIENT_IP_HEADER=x-vercel-forwarded-for`
(`NETRICS_TRUSTED_PROXY_HOPS` does not apply).

The API side does not work as it stands. The request reaches the API from
a Vercel egress address (dynamic, public, not in
`NETRICS_TRUSTED_PROXIES`) through Railway's edge, so `request.ip` would be
a Vercel or Railway address shared by all users. Sign-in would be limited to
10 per minute for everyone together, and pairing to 10 per 10 minutes for
all TVs. **Prerequisite:** with `NETRICS_PROXY_SECRET` set, the API takes the
client address from a dedicated header (`x-netrics-client-ip`, which the
proxy sets and the API validates as an IP address) only on requests that
carry the valid secret. Otherwise it uses `request.ip` as today. The
rate-limit bridge and the pairing route read this one resolved value. Tests
cover spoofed headers without the secret, a wrong secret, and a malformed
address. The web side should also reject a configured header whose value is
not a single IP address, rather than keying limits on an arbitrary string.

### Host redirects, `/healthz`, CSP, cookies

- **Host redirects.** On Vercel, `host` is the custom domain the visitor
  used. `proxy.ts` (Next.js 16's renamed middleware) runs as Vercel routing
  middleware before every route, as it does in the standalone server.
  `NETRICS_APP_ORIGIN=https://app.netrics.so` is set for the production
  environment only. Generated `*.vercel.app` deployment URLs then redirect to
  the app origin except the exempt paths, which is what the smoke check
  needs. `NETRICS_PAIRING_HOST` stays unset: netrics.tv is its own site. To
  verify on the first deployment: the middleware reads `process.env` at
  request time (the code passes `process.env` as an object, which must not be
  empty in the middleware runtime). If it is empty, the configuration is
  read through an explicit allowlist of names.
- **`/healthz`** is a function route on Vercel and stays dependency-free.
  Vercel has no container health check; it serves the smoke check. To let the
  smoke check confirm the web commit on both platforms, `/healthz` also
  reports the version and commit (for example
  `{"status":"ok","version":…,"commit":…}`; the Docker `HEALTHCHECK` and
  Railway probe check only the status code).
- **CSP and security headers** come from `next.config.ts` `headers()`, which
  Vercel applies. Nothing that injects scripts is enabled (Vercel Toolbar,
  Web Analytics, Speed Insights), so the CSP stays as is. Skew protection,
  if enabled, needs no CSP change.
- **Cookies.** Better Auth sets host-only cookies for `app.netrics.so`
  through the proxy, and sessions live in PostgreSQL. The origin does not
  change, so sessions, `WEB_ORIGIN`, `BETTER_AUTH_URL`, CORS and the Origin
  checks on mutations all stay valid through the DNS switch.

### OAuth callback (ADR 0012)

Unchanged. The redirect URI is `<WEB_ORIGIN>/oauth/<provider>/callback`,
and the origin does not change, so no provider console needs an update. The
route handler forwards to the API through `NETRICS_API_URL`, now with the
proxy secret. The callback adds no new limit (no large body, short request).

### Releases and versions

- **Build.** The private workflow's prepare step checks out the dispatched
  commit, runs `vercel build` with only the two `NEXT_PUBLIC_*` values, and
  `vercel deploy --prebuilt --prod --skip-domain`: a production deployment
  that does not receive the domain yet. It records the deployment ID beside
  the image digests. This can run in parallel with the API deployment.
- **Order.** It stays as today. The API deploys first, and its pre-deploy
  step runs the migrations with the candidate server image. The workflow
  waits for `/health/ready` at the candidate commit. Then the staged web
  deployment is checked on its deployment URL (`/healthz` reports the
  candidate commit; a protection bypass token is needed if deployment
  protection is on) and promoted with `vercel promote`. Worker and scheduler
  follow. Expand/migrate/contract migrations keep the old frontend working
  against the new API during the window, as they do now.
- **Smoke.** It checks the API's `/health/live` commit (as CLAUDE.md asks)
  and the commit reported by `https://app.netrics.so/healthz`, and loads
  `/status`, which shows both versions.
- **Rollback.** `release/production.yaml` records the image digests and the
  web deployment ID together. Rolling back redeploys the previous digests on
  Railway and promotes the previous Vercel deployment (instant, no rebuild).
  Rolling back the web alone is possible because of expand/contract.
- **Self-hosters.** Unchanged: `release.yml` still builds, signs and attests
  both images, `promote.yml` still tags digests, and Compose still runs the
  web image. The web image stays a released artifact, tested in CI and in the
  `selfhost` check, even though the hosted service no longer runs it.

### Limits and costs (qualitative)

- **Duration.** Functions default to 300 s with fluid compute (Pro: up to
  800 s) ([limits](https://vercel.com/docs/functions/limitations)). netrics
  has no streaming responses or long-held requests; the longest are
  connection previews and checks against provider APIs, well under that. Set
  a `maxDuration` on the proxy routes anyway, so a hung API call ends with a
  clear 504 instead of using the full budget.
- **Body size.** Vercel functions accept at most 4.5 MB of request _and_
  response body. The 1 MiB proxy cap on requests stays the binding limit.
  Responses are new: an API response over 4.5 MB through the proxy would
  fail on Vercel but not on Railway. Lists are paginated today; a test
  should check the largest responses (observations, metric queries) stay
  well under, or the limit should go into the API contract.
- **Cost.** Every proxied request is a function invocation, billed by active
  CPU and memory time. Waiting on the API costs memory time but not CPU.
  Continuous polling by TVs and kiosks is the steady part. Transfer between
  Vercel and Railway is billed on both sides. At current scale this should
  be small, but it grows with the number of screens rather than users. A
  later optimization: serve `/v1/*` through a Vercel external rewrite (edge
  proxy, no function) with the secret added by a header transform. That
  splits the hosted proxy from the self-hosted one, so it is not part of
  this decision.
- **Skew.** Vercel's skew protection can pin a client's asset requests to
  its deployment across a release. Not needed for correctness, since the
  API contract is versioned, but available.

### Cut-over plan

1. Ship the prerequisites (proxy secret, authenticated client IP, `/healthz`
   commit, single fetch helper, the CI build guard) and deploy them on
   Railway first, with the secret set on both services. This proves them on
   the current platform.
2. Create the Vercel project in the private infrastructure repository (as
   code, like the netrics.tv site): Git deployments off, function region
   co-located with the API, production environment variables, deployment
   protection for generated URLs. Extend the private release workflow to
   build, stage and promote as above. For a while, deploy every release to
   both platforms.
3. Before touching DNS: add `app.netrics.so` to the Vercel project and
   [pre-generate its certificate](https://vercel.com/docs/domains/pre-generating-ssl-certs)
   through the TXT challenge, so there is no window without a valid
   certificate. Check the staged production with
   `curl --resolve app.netrics.so:443:<vercel address>`: sign-in, a dashboard,
   `/v1/device/*` with a device token, the kiosk, the OAuth callback with the
   fixture provider (ADR 0012), `/status`, and that the API sees real client
   addresses (a failed sign-in counts against the tester's address, not a
   shared one). Lower the DNS TTL a day ahead.
4. Switch the `app.netrics.so` record from Railway to Vercel. Sessions
   continue, since the origin is unchanged.
5. Verify on the live domain: `/healthz` commit, `/status`, sign-in, a TV
   keeps refreshing (its credentials are origin-independent), auth
   rate-limit keys in the API are client addresses, no rise in 5xx or
   latency in Vercel and API logs, and no traffic still arriving at the
   Railway web service after the TTL.
6. **Rollback path:** point the record back at Railway. The Railway web
   service keeps receiving every release for an agreed period (for example
   two weeks), so rolling back is a DNS change to a current build. Then
   remove the Railway web service and its private-network setting, and update
   CLAUDE.md, `docs/release.md` and ADR 0005.

## Consequences (if accepted)

- CLAUDE.md's invariant is reworded as in option B. The web image remains a
  first-class, signed release artifact for self-hosters, but production no
  longer runs it.
- The API gains an optional proxy secret and authenticated client-IP
  forwarding. Both are useful to self-hosters who put the web app and API on
  different hosts.
- Hosted web→API traffic leaves Railway's private network and is encrypted
  in transit. The API's public address becomes load-bearing and is protected
  by the secret.
- The private release workflow deploys to two platforms and records one more
  identifier per release. Hosted web rollbacks are Vercel promotions.
- The hosted frontend gets Vercel's CDN for static assets, its firewall and
  DDoS protection, and the same operations model as other Lab80 frontends.

## To decide

1. **Move at all (B), or keep the image on Railway (A)?** The case for B is
   platform consistency, CDN and firewall. The cost is a weaker invariant,
   new security-relevant code, an extra public hop, and a second deploy
   target. A remains a sound choice if consistency is the only driver.
2. **The invariant's new wording**, or whether the hosted frontend must keep
   running a signed digest. In that case, D when it is generally available,
   or A until then.
3. **Whether the API refuses all non-frontend traffic** when the secret is
   set (proposed), or only uses the secret to trust the client IP.
4. **The function region**, matching the API's Railway region, and the
   latency budget that gates the cut-over.
5. **How long the Railway web service stays as a warm rollback target**
   after the DNS switch.
6. **Vercel plan features:** Pro for `maxDuration` above 300 s (not needed
   now), and whether to enable skew protection. Static IPs are not proposed.
