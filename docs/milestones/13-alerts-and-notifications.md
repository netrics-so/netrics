# Milestone 13 — Alerts and notifications

## Outcome

A user can define a reliable threshold rule over a normalized or derived metric
and receive email or webhook notifications without alert storms.

## Dependencies

- Milestones 10 and 12

## In scope

- Alert rule model and metric-query reuse
- Healthy, pending, firing, recovering, paused, and insufficient-data states
- Threshold, duration, evaluation interval, and cooldown
- Missing-data and stale-data behavior
- Evaluation after ingestion and on schedule
- Durable notification outbox
- Email notification adapter
- Generic signed webhook adapter
- Retry, dead-letter, delivery history, and manual test
- Recovery notifications and alert acknowledgement
- Alert UI, status history, and audit events

## Out of scope

- Incident-management escalation policies
- SMS, Slack, Discord, and mobile push
- Machine-learning anomaly detection
- User-authored notification code

## Implementation slices

1. Define rule configuration and state transitions.
2. Reuse bounded metric queries for deterministic evaluation.
3. Add ingestion-triggered and scheduled evaluation.
4. Implement transactional notification outbox and idempotency.
5. Add email delivery with self-hosted SMTP configuration.
6. Add signed webhooks, retries, and delivery inspection.
7. Build creation, preview, pause, history, and test UX.
8. Add recovery, cooldown, missing-data, and failure simulations.

## Correctness invariants

- Replaying an evaluation cannot emit duplicate notifications.
- Cooldown and required duration use persisted timestamps.
- Evaluation distinguishes no data, stale data, and a numeric zero.
- A failing notification channel does not block rule evaluation.
- Deleted workspace resources cancel future evaluations safely.

## Verification

- State-machine tests cover every allowed and rejected transition.
- Clock-controlled tests cover duration and cooldown boundaries.
- Worker retries produce one logical delivery.
- Webhook signatures verify and rotate correctly.
- SMTP and webhook failures remain visible and retryable.

## Exit gate

Create a rule, drive it through pending, firing, recovering, and healthy states
with controlled observations, and show exactly one email and one signed webhook
for the configured transitions.
