# netrics — Product Vision & Features

> Status: agreed product direction. This document captures the product promise,
> business model, user-facing concepts, and initial scope. Technical decisions
> live in [architecture.md](./architecture.md). Implementation is sequenced in
> the [v1 milestone roadmap](./milestones/README.md).

## What is netrics?

netrics collects metrics from many different services and turns them into
dashboards that work anywhere, especially on shared office screens and Apple TV.

The core promise:

> See your most important numbers at a glance, on any screen, without building
> or operating a data pipeline.

A product team might combine website visitors from Vercel Analytics, downloads
from App Store Connect, Apple Ads spend, and Google Search Console performance
on one rotating office display.

The first customer is a small product team. Fast setup, clear defaults, and a
polished managed service matter more than infrastructure flexibility in the
main product experience. Self-hosting remains a complete, supported way to run
the same product.

## Business model

Two consumption modes, one product:

- **SaaS** — hosted by netrics. A workspace is created, users are invited, and
  reviewed connectors can be connected from the marketplace in minutes.
- **Self-hosted** — the complete product, with no license key or feature gates.
  A user can run it with Docker Compose using the same published application
  images as the hosted service.

The managed service sells operational value:

- Managed infrastructure, upgrades, backups, and monitoring
- Preconfigured OAuth applications and easy connector authorization
- Reviewed community connectors and rapid connector rollouts
- Managed email and notification delivery
- Custom domains and TLS
- Support and recovery tooling

Hosted plans may apply usage and resource limits. These are hosting policies,
not locked product capabilities. The open core supports generic
operator-configured limits and self-hosted installations default to unlimited.

### Licensing and brand

- The server and official web application are intended to use AGPLv3.
- The connector SDK and templates should use a permissive license such as
  Apache-2.0 or MIT to encourage connector development.
- The netrics name, marks, and visual identity need a clear trademark policy.
- A compliant third party may host AGPL software under another brand. The
  business moat is the trusted brand, connector quality, product experience,
  and managed operation.
- The final license and contributor agreement should receive legal review
  before accepting outside contributions.

## Product hierarchy

### Installation

One running netrics deployment. A self-hosted installation normally serves one
company and creates its first workspace during onboarding. The data model still
supports multiple workspaces so an installation can serve several isolated
organizations when needed.

### Workspace

The tenant, security, and hosted billing boundary. A workspace owns members,
projects, connections, dashboards, alerts, playlists, and devices.

### Project

An optional organizational boundary inside a workspace. Projects can represent
a product, client, business unit, or environment. Connections and dashboards
may be assigned to projects, while a dashboard may intentionally combine data
from several projects in the same workspace.

Projects do not replace workspace isolation. Separate companies that require
isolated memberships and credentials use separate workspaces.

### User and roles

A person may belong to several workspaces. Initial workspace roles are owner,
admin, editor, and viewer. Authentication should support modern consumer and
enterprise methods over time: password, social login, passkeys, two-factor
authentication, OIDC, SAML, and SCIM.

### Connector

A reviewed integration definition that knows how to authenticate with a service,
discover available resources, and collect normalized metrics. Connector code is
installed by the netrics deployment operator, not separately by each tenant.

### Connection

A configured instance of a connector inside a workspace. A workspace can create
any number of connections using the same connector, for example two App Store
Connect teams or separate production and client accounts. Each connection has
its own credentials, selected resources, synchronization state, and health.

### Metric and observation

A metric defines meaning, unit, dimensions, and valid aggregation behavior. An
observation is a timestamped value collected from a connection.

### Dashboard

A grid of widgets bound to metrics from one or more connections. Dashboards can
combine data across projects within a workspace.

### Device and playlist

A registered screen such as Apple TV, a browser kiosk, or a Raspberry Pi. A
device displays one dashboard or a playlist that rotates several dashboards.

## Features

### Connector marketplace

- One-click connection flow from a marketplace UI
- First-party and reviewed community connectors in the hosted catalog
- Multiple connections per connector and workspace
- Guided authentication, resource discovery, metric selection, and backfill
- Connector documentation, permissions, refresh constraints, and health shown
  before connection
- Private custom API definitions that can optionally be submitted for community
  review and publication

"Install" is a product action: it opens the connection wizard and creates a
tenant-scoped connection. Hosted workers already contain the reviewed connector
code, so a tenant action never downloads an arbitrary package into the runtime.

### Initial connectors

The initial connector set is:

1. Vercel Web Analytics
2. Google Search Console
3. App Store Connect
4. Apple Ads

These exercise bearer tokens, user OAuth, signed JWT credentials, client
credentials, resource discovery, reporting dimensions, and rate limits. They
form a useful foundation for the connector SDK.

### Custom API connector

A declarative connector builder provides a flexible solution without executing
user-provided JavaScript. Users can configure:

- HTTP GET endpoints, headers, query parameters, and supported authentication
- Pagination
- Record extraction from JSON responses
- Timestamp, numeric value, unit, and dimension mappings
- Restricted calculations and transformations
- Refresh interval and backfill behavior
- Test requests and metric previews

Definitions are private to the workspace by default and exportable as JSON.

### Data collection

- Scheduled pulling with connector-specific minimum refresh intervals
- Push or webhook ingestion can be added through the same normalization layer
- Historical backfill where supported by the source
- Durable synchronization cursors and idempotent writes
- Rate-limit handling, exponential backoff, and quota visibility
- Connection health: last attempt, last success, duration, errors, and auth state
- Encrypted credential storage and centrally managed standard OAuth flows
- Optional short-lived diagnostic payload retention without retaining raw source
  data indefinitely

### Data processing

- Time-window aggregation and rollups
- Filters and transformations
- Dimensions such as project, country, campaign, route, device, or app
- Derived metrics across connections, for example downloads divided by website
  visitors
- Unit, currency, time-zone, and aggregation validation for derived metrics

### Dashboards

- Widget library: big number, trend, line, bar, table, gauge, and status
- Grid editor with drag and drop
- Dark-theme-first TV layouts with strong distance readability
- Auto-refresh and stale-data indication
- Workspace and optional project organization
- Revocable public links and embeds
- Demo data during onboarding so the first dashboard is useful immediately

### Apple TV and screens

Apple TV support is part of the initial product and its public launch story.

- Native SwiftUI tvOS application
- Short-code pairing from the authenticated web application
- Device-scoped, rotating, revocable credentials
- Server-rendered dashboard snapshots shared with the web experience
- Playlist manifest and remote playlist changes
- Cached last-known dashboard during temporary outages
- Device heartbeat and diagnostics
- Browser kiosk URLs as a fallback for other screens
- Initial snapshot refresh target of roughly 30–60 seconds

Native widget rendering may be added later if customer demand requires smoother
animation or near-real-time updates.

### Alerts and notifications

- Rules over any normalized or derived metric
- Evaluation after ingestion and on scheduled windows
- Pending, firing, recovering, and healthy states
- Duration, cooldown, missing-data behavior, and recovery notifications
- Notification channels implemented separately from source connectors
- Initial channels: email and generic webhook
- Later channels: Slack, Discord, mobile push, and others

### Users and administration

- Workspace invitations and roles
- Password, social login, passkeys, and two-factor authentication first
- Generic OIDC next; SAML and SCIM supported as enterprise identity capabilities
- Audit log for security and configuration changes
- Instance settings for email, storage, retention, and authentication
- Workspace export and deletion

## SaaS-only operational systems

These systems operate the hosted service and do not remove features from the
self-hosted product:

- Billing, subscriptions, and usage metering
- Workspace provisioning and lifecycle automation
- Custom domains and certificate automation
- Managed OAuth application configuration
- Support and fleet operations console
- Marketing site, campaign systems, and hosted documentation

Private cloud systems use public administration APIs and lifecycle events. They
do not read or write the core database directly.

## Positioning

| Product               | Relation                               | Opportunity for netrics                                        |
| --------------------- | -------------------------------------- | -------------------------------------------------------------- |
| Geckoboard            | Closest comparable SaaS TV dashboard   | Self-hosting, Apple TV, connector openness, friendlier pricing |
| Plecto                | Strong pairing and playlist experience | Lower entry cost, self-hosting, small-team focus               |
| Grafana               | Powerful and self-hostable             | Simpler onboarding, metric semantics, polished devices         |
| Dashing / Smashing    | Open-source TV dashboards              | Maintained product, auth, pairing, marketplace, alerts         |
| Digital signage tools | Strong screen fleet management         | Metric-native connections and dashboards                       |

Positioning:

> The polished metrics screen for product teams: connect services in minutes,
> share the numbers that matter, and run it in our cloud or your own.

## Remaining product questions

- Hosted pricing: workspace plus refresh/data tier is the leading direction;
  screens and viewers should probably remain unlimited.
- Default and maximum retention by plan and self-hosted installation
- Which notification channels follow email and webhooks
- When near-real-time push ingestion becomes more valuable than scheduled pull
- Whether project-level membership restrictions are needed after launch
