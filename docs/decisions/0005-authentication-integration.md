# 0005 — Authentication integration: Better Auth behind adapters

Status: accepted (milestone 02)

## Context

Milestone 02 adds identity and tenancy: email/password auth, sessions, and a
mapping from an authentication identity to the installation-level domain user
that tenant rows reference. The architecture treats auth as a replaceable
subsystem and requires instant session revocation, RLS-compatible storage,
and a self-hosted web app served from a different origin than the API.

## Decision

- **Better Auth, pinned at 1.7.5**, with `@better-auth/drizzle-adapter` at the
  same version. Better Auth ships as a split package train (core plus adapter
  packages that must move in lockstep), so both versions are pinned exactly in
  `apps/server/package.json` and bumped together only.
- **Auth tables live in a dedicated `auth` PostgreSQL schema.** The drizzle
  table definitions in `packages/database/src/auth-schema.ts` are generated
  with `npx auth generate` and committed unedited; that file is the source of
  truth for auth tables and must be regenerated (never hand-edited) when the
  Better Auth version changes. drizzle-kit turns it into ordinary migrations
  alongside the domain schema.
- **One narrow adapter module** (`apps/server/src/auth/`) is the only import
  site for `better-auth`. The rest of the server sees just the `AuthService`
  surface: mounting `/api/auth/*` and resolving request headers into a
  `SessionIdentity` (auth user id + domain user id). The web app has its own
  thin client adapter under `apps/web/src/lib/`.
- **Database sessions without `cookieCache`.** Every session check hits the
  `auth.session` table, so sign-out and password reset revoke sessions
  instantly (`revokeSessionsOnPasswordReset: true`). The revoked-session
  guarantees are pinned by the adversarial cross-workspace suite.
- **Domain user provisioning via `databaseHooks`.** Every created auth user is
  mirrored into the domain `users` table by a hook; `getSessionIdentity`
  self-heals (re-provisions on demand) if the hook ever failed, so a session
  can never be permanently unusable. Session creation also writes the
  installation-level `auth.login` audit event.
- **Same-origin proxy for the web app.** The Next.js server proxies
  `/api/auth/*` and `/v1/*` to the API via `next.config.ts` rewrites, so the
  browser only ever sees first-party cookies — no CORS, no cross-site cookie
  flags. Server-side fetches and the rewrites read `NETRICS_API_URL`, which
  the web Dockerfile bakes as a build-time `ARG` (Next inlines it into the
  standalone output).
- **Dev mailer until milestone 13.** Verification and password-reset emails
  are logged by a logging mailer (`requireEmailVerification: false`) until
  real SMTP/alerting infrastructure arrives in milestone 13.

## Alternatives considered

- **Auth.js / rolling our own sessions** — more code to own for password
  hashing, reset tokens, and session storage; Better Auth covers the flows
  with a drizzle adapter that fits the existing stack.
- **JWT / cookie-cached sessions** — cheaper per request, but revocation
  depends on token expiry, which contradicts the instant-revocation
  requirement.
- **Cross-origin cookies (`SameSite=None`) from web to API** — avoids the
  proxy, but couples deployments to cookie-domain configuration and trips
  third-party-cookie blocking; the rewrite keeps the browser surface
  same-origin.

## Consequences

- Upgrading Better Auth means bumping the pinned train together and
  regenerating `auth-schema.ts`; the adapter module isolates API churn.
- Session checks cost one indexed DB read per request; acceptable at this
  scale, and `cookieCache` can be reconsidered if it ever matters.
- Until invitations land (milestone 14), members are added by email against
  the installation-level users table. This makes account existence
  probeable by any workspace admin (`404 user_not_found` vs success on
  `POST /members`) — an accepted trade-off, recorded in the milestone 02 doc
  and pinned by tests, to be revisited with milestone 14.
- The web image must be rebuilt (or the build arg supplied) when the API
  origin changes; runtime-only changes to `NETRICS_API_URL` have no effect.
