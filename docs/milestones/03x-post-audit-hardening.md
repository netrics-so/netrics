# Milestones 03.1–03.3 — Post-audit hardening

## Why these exist

After milestone 03, an independent review of milestones 00–03 (September 2026)
found gaps in security configuration, in scheduler and job correctness, and in
image portability. None of these showed up in the milestone exit gates. All of
them are cheaper to fix now, before production data exists and before
dashboards build on the metric schema.

Work is tracked as GitHub issues under the matching GitHub milestones.
Production-specific steps (secrets, database roles on the hosted service) are
tracked in the private cloud repository.

## 03.1 — Security hardening

Outcome: no installation starts with known credentials, a privileged database
role, or an unclaimed owner slot. Production deploys are unblocked.

- #21 Provision database role passwords from environment, not migrations
- #22 Refuse to start api/worker as a superuser or BYPASSRLS role
- #23 Scope every connection query by workspace explicitly
- #24 First-run setup token; sign-up disabled by default
- #25 Require https auth URLs in production; trusted proxy config
- #26 Never log auth tokens; fail closed until an email transport exists
- #27 Verified email before membership; consent-based invitations
- #28 Reject known development secrets in production
- #29 Credential envelopes: AAD binding, key id, tag length
- #30 API hardening bundle

Exit gate: the hosted service runs api and worker as `netrics_app`, with
rotated role passwords and the startup guard active. A release for current
`main` deploys successfully. The cross-workspace test suite passes both with
and without RLS.

## 03.2 — Sync and data-layer correctness

Outcome: syncs run at their configured interval, exactly one scheduler is
active, jobs cannot be completed twice, and the observation schema is final
enough for dashboards and real connectors.

- #31 Scheduler enqueues only once per clock hour
- #32 Scheduler advisory lock can be lost silently
- #33 Job leases, fencing and per-connection serialization
- #34 Worker: no long-lived outer transaction
- #35 Observation schema v2
- #36 Connector catalog sync at boot; read-only catalog for the app role
- #37 OpenAPI spec generated from zod route schemas
- #38 Extract connections service and repository
- #39 Fix package dependency direction
- #40 Jobs retention, claim index and foreign key
- #41 Connector runtime guardrails

Exit gate: replay the milestone 03 exit gate. Additionally:

- a 5-minute poll interval produces about 12 syncs per hour
- a killed scheduler lock connection stops that scheduler
- a revised provider value replaces the stored one

## 03.3 — Portable images and self-hosting

Outcome: the published images run unchanged in SaaS and self-hosted
installations, and a stranger can install netrics over https in five minutes.

- #42 Web image resolves the API URL at runtime
- #43 `deploy/compose` five-minute install
- #44 Harden Dockerfiles
- #45 Release pipeline: semver tags, pinned actions, attestations
- #46 CI self-host install smoke test
- #47 Park the renderer placeholder

Exit gate: on a fresh VM, `install.sh` produces a working https instance from
published images, and the CI smoke test guards that path.

03.2 and 03.3 may run in parallel once 03.1 is merged.

## Completion: 03.1

- Completed: 2026-09-27
- Pull requests: #63, #65, #66, #68, #69, #70
- Exit gate: the hosted service runs api and worker as `netrics_app` with
  rotated role passwords and the privileged-role guard active. Releases for
  current `main` deploy and pass the smoke test. The cross-workspace suite
  passes with and without RLS (`connections.privileged.test.ts`).
- Material deviations: rate limiting behind the web proxy moved to #64
  (03.3). "Unverified accounts cannot accept invitations" is implemented as
  "acceptance requires the invitation token plus a matching email" (#70),
  because installations without SMTP have no verification mail.
