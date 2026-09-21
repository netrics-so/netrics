# Milestone 15 — SaaS control plane

## Outcome

The managed service can provision, bill, limit, support, and retire customer
workspaces while the public core remains complete and self-hostable.

## Dependencies

- Milestones 01–14

## In scope

- Private cloud service authentication to the public administration API
- Workspace provisioning and lifecycle state
- Stripe customer, checkout, subscription, invoice, and webhook handling
- Plan definitions and hosted usage aggregation
- Generic core limits configured by the control plane
- Billing-state and limit UX in the hosted product
- Managed OAuth application configuration
- Custom-domain request, verification, and certificate workflow
- Support console with audited impersonation or support sessions
- Fleet health, release visibility, and workspace diagnostics
- Trial, cancellation, grace period, export, and deletion workflow
- Marketing-site signup handoff

## Out of scope

- Feature gates in the self-hosted product
- Direct private-service access to the core database
- Usage-based invoicing beyond the selected v1 pricing model
- Reseller and white-label billing

## Implementation slices

1. Define signed admin API calls and lifecycle event delivery.
2. Add idempotent workspace provisioning and lifecycle records.
3. Integrate Stripe checkout, subscriptions, and webhook reconciliation.
4. Aggregate usage and configure generic hosted limits.
5. Add hosted billing and limit-recovery UX.
6. Add managed OAuth and custom-domain operations.
7. Build audited support sessions and fleet diagnostics.
8. Implement cancellation, export, retention, and deletion end to end.

## Boundary invariants

- Private services use public APIs and events, never core database credentials.
- Stripe webhooks are verified, idempotent, and reconciled periodically.
- A billing outage does not corrupt or silently delete customer data.
- Self-hosted installations default to unlimited without the control plane.
- Support access is explicit, time-limited, visible, and audited.
- Destructive lifecycle transitions have grace periods and recovery procedures.

## Verification

- Replayed and reordered Stripe events converge on the correct subscription.
- Provisioning retries create one workspace.
- Limit changes are visible and reversible.
- A private service cannot bypass core authorization.
- Cancellation, export, grace period, and deletion match published policy.
- Custom-domain failure leaves the default domain operational.

## Exit gate

Start from the marketing signup, purchase a plan in Stripe test mode, provision a
workspace, enforce and upgrade a hosted limit, open an audited support session,
cancel, export, and complete the deletion lifecycle.
