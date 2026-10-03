# netrics v1 implementation roadmap

> This roadmap turns the product and architecture into small, sequential
> delivery units. Complete one milestone before opening the next one.

## How to use this roadmap

Each milestone ends in a working state that can be demonstrated and deployed.
Milestones are ordered by dependency and product learning, not by technical
layer. A milestone is complete only when its exit gate passes.

Working rules:

1. Keep `main` deployable.
2. Build only the abstractions required by the current milestone.
3. Split milestone work into reviewable pull requests, each leaving tests green.
4. Put database changes in forward-compatible migrations.
5. Record a new architectural decision in `docs/decisions/` only when the
   existing architecture does not answer it.
6. Keep unfinished UI unavailable outside development rather than exposing
   nonfunctional controls.
7. Run the milestone's end-to-end scenario before marking it complete.
8. Update the relevant milestone file when scope changes; do not silently move
   unfinished work forward.

## Version 1 outcome

Version 1 is complete when a small product team can:

- Create a workspace, invite people, and assign roles
- Organize connections and dashboards with optional projects
- Connect Vercel Web Analytics, Google Search Console, App Store Connect, and
  Apple Ads from the marketplace
- Create several connections using the same connector
- Create a declarative custom API connection
- Build dashboards from normalized and derived metrics
- Pair an Apple TV, assign a playlist, and manage it remotely
- Create alerts that deliver email or webhook notifications
- Share dashboards through revocable links
- Use modern login methods, OIDC, SAML, and SCIM
- Buy and operate the hosted service
- Install the same complete product through Docker Compose

The hosted service runs immutable public server images on Railway and builds
the web frontend on Vercel from the same commit (ADR 0013). The self-hosted
distribution runs the signed images.

## Sequence

| Milestone                                                                 | Working result                                     |
| ------------------------------------------------------------------------- | -------------------------------------------------- |
| [00 — Repository foundation](./00-repository-foundation.md)               | Local web, API, and PostgreSQL skeleton            |
| [01 — Delivery foundation](./01-delivery-foundation.md)                   | A merge to main deploys exact images to Railway    |
| [02 — Identity and tenancy](./02-identity-and-tenancy.md)                 | Secure workspace login and isolation               |
| [03 — Connector and metrics spine](./03-connector-and-metrics-spine.md)   | Demo connector syncs durable observations          |
| [03.1–03.3 — Post-audit hardening](./03x-post-audit-hardening.md)         | Secure roles, correct sync, portable self-host     |
| [04 — Dashboard MVP](./04-dashboard-mvp.md)                               | A browser dashboard displays collected data        |
| [05 — Vercel Web Analytics](./05-vercel-connector.md)                     | First real marketplace connection                  |
| [06 — Screens and Apple TV](./06-screens-and-apple-tv.md)                 | Paired Apple TV displays a managed playlist        |
| [07 — Google Search Console](./07-google-search-console.md)               | Reusable user OAuth and Google metrics             |
| [08 — App Store Connect](./08-app-store-connect.md)                       | Signed-key auth and app-store metrics              |
| [09 — Apple Ads](./09-apple-ads.md)                                       | Client-credential auth and advertising metrics     |
| [10 — Projects and derived metrics](./10-projects-and-derived-metrics.md) | Cross-connection analysis and organization         |
| [11 — Community connector system](./11-community-connectors.md)           | Public SDK, template, catalog, and review pipeline |
| [12 — Custom API connector](./12-custom-api-connector.md)                 | Safe declarative connection builder                |
| [13 — Alerts and notifications](./13-alerts-and-notifications.md)         | Stateful rules deliver email and webhooks          |
| [14 — Collaboration and access](./14-collaboration-and-access.md)         | Complete sharing, identity, and administration     |
| [15 — SaaS control plane](./15-saas-control-plane.md)                     | Billing, provisioning, limits, and operations      |
| [16 — Production hardening and v1](./16-production-hardening.md)          | Tested self-host and SaaS v1 release               |

## Dependency map

```text
00 repository
└── 01 delivery
    └── 02 identity and tenancy
        └── 03 connector and metrics spine
            └── 03.1 security hardening
                ├── 03.2 sync and data-layer correctness
                └── 03.3 portable images and self-hosting
                    └── 04 dashboard MVP (after 03.2 and 03.3)
                └── 05 Vercel
                    └── 06 screens and Apple TV
                        └── 07 Google Search Console
                            └── 08 App Store Connect
                                └── 09 Apple Ads
                                    └── 10 projects and derived metrics
                                        └── 11 community connectors
                                            └── 12 custom API
                                                └── 13 alerts
                                                    └── 14 collaboration
                                                        └── 15 SaaS control plane
                                                            └── 16 v1 hardening
```

The ordering is intentionally strict for a solo implementation. Later, a larger
team could parallelize independent connectors after milestone 07.

## Current status

- Done: 00, 01, 02, 03, 03.1 (security hardening), 03.2 (sync and data
  layer), 03.3 (portable images and self-hosting; release `v0.1.0`), 04
  (tile dashboards, TV layout, demo onboarding), 05 (Vercel Web Analytics
  connector)
- In progress: 06 (Apple TV). Server side, browser kiosk, the tvOS app and
  the device heartbeat in the TV list are done; the hosted service pairs TVs
  through netrics.tv. Open: signing, a physical Apple TV and the exit gate
  (#58), blocked by the Apple TV development connection (#129).
- Planned: 07 (Google Search Console). OAuth platform decided in
  [ADR 0012](../decisions/0012-oauth-authorization-code-platform.md); issues
  #131–#138.
- Planned: 08 (App Store Connect). Signed-key credentials and report
  sources proposed in
  [ADR 0014](../decisions/0014-app-store-connect-signed-keys.md); issues
  #170–#177.
- Later: the web frontend on Vercel (#123).
- Tracking: GitHub milestones, issues and the "netrics roadmap" project
  board; hosted-service steps are tracked in the private cloud repository

The MVP target is an Apple TV showing demo and Vercel metrics. See
[ADR 0007](../decisions/0007-native-tvos-tiles.md) for the native-tiles
decision.

## Milestone completion record

When a milestone is done, add a short completion block to its file:

```md
## Completion

- Completed: YYYY-MM-DD
- Release: v0.x.0
- Pull requests: ...
- Material deviations: ...
```

Do not pre-fill completion sections. The roadmap describes intended work; the
Git history and completion record describe what actually shipped.
