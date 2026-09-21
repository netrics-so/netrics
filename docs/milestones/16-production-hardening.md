# Milestone 16 — Production hardening and v1 release

## Outcome

The complete product is secure, observable, recoverable, documented, and
released as version 1 for both SaaS and self-hosted customers.

## Dependencies

- Milestones 00–15

## In scope

- Threat model and security review of auth, tenancy, connectors, rendering,
  custom HTTP, sharing, devices, billing, and support access
- Dependency, container, secret, and license scanning
- Load and longevity tests for ingestion, queries, jobs, renderer, and tvOS
- PostgreSQL backup, point-in-time recovery, and restore rehearsal
- Object-storage versioning and second-copy recovery
- Structured logs, traces, metrics, alerts, and external uptime checks
- Scheduler and worker heartbeat monitoring
- Retention, deletion, and privacy verification
- Image signing, provenance, SBOMs, and source release tags
- Self-host installation, upgrade, backup, and rollback documentation
- SaaS incident, credential-rotation, and restore runbooks
- Connector author documentation and API reference
- Accessibility, responsive, TV-distance, and failure-state review
- tvOS App Store submission assets and release
- AGPL, SDK license, contributor terms, and trademark policy
- v1 migration freeze and release notes

## Out of scope

- New connectors or major product capabilities
- Kubernetes or Helm support
- Native chart rendering on tvOS
- Unvalidated performance optimizations

## Implementation slices

1. Freeze v1 scope and resolve every incomplete milestone exit gate.
2. Run threat modeling and fix high- and critical-risk findings.
3. Establish realistic load profiles and remove measured bottlenecks.
4. Rehearse PostgreSQL and object-storage restoration with recorded RPO/RTO.
5. Complete observability, paging thresholds, and incident runbooks.
6. Verify retention, export, deletion, and privacy promises.
7. Test self-host install and upgrade on clean supported environments.
8. Finish signing, licensing, docs, App Store release, and launch artifacts.

## Release gates

- All automated suites pass against the exact release images.
- No open critical or high security findings.
- Cross-workspace isolation tests pass.
- Backup restores have been completed and timed.
- Previous-version rollback has been rehearsed.
- Hosted and Compose installations use identical image digests.
- Connector credentials and custom API protections pass redaction/security tests.
- Apple TV pairing, offline cache, rotation, and revocation pass on real hardware.
- Billing and deletion flows pass in production-like environments.
- Documentation has been followed from a clean machine by someone other than
  the implementation context, or through an equivalent clean-room exercise.

## Version 1 acceptance scenario

1. Install netrics through Docker Compose and create the first owner.
2. Create projects and invite users with different roles.
3. Connect all four first-party providers and one custom API.
4. Build a dashboard with normalized and derived metrics.
5. Pair an Apple TV and remotely assign a playlist.
6. Trigger and recover an alert delivered through email and webhook.
7. Share and revoke a dashboard.
8. Back up, upgrade, restore, and roll back the installation.
9. Repeat the customer journey in SaaS through signup, billing, and cancellation.

## Exit gate

Tag and publish v1.0.0, deploy the exact signed images to production, publish the
self-hosted release and documentation, release the tvOS app, and complete the
full acceptance scenario without undocumented intervention.
