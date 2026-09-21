# Milestone 01 — Delivery foundation

## Outcome

A green merge to the public `main` branch publishes immutable images and
deploys those exact digests to a disposable Railway environment. Infrastructure
changes receive a Terraform plan on pull requests and apply after merge.

## Dependencies

- Milestone 00

## In scope

- Private `netrics-cloud` repository skeleton
- Railway sandbox project with web, API, worker, scheduler, and renderer services
- PostgreSQL service and private networking
- Versioned remote Terraform state with locking
- Pinned Railway Terraform provider acceptance test
- Separate Terraform root for Railway
- `railway.toml` or equivalent native service configuration
- 1Password-backed `.env.op` templates
- Plan-on-PR and apply-on-main reusable workflows
- Public GHCR images tagged by commit and referenced by digest
- Private production release manifest format
- Migration-before-rollout workflow
- Health-gated rollout and smoke test
- Manual workflow dispatch and digest rollback

## Out of scope

- Production customer data
- Billing, custom domains, and production DNS
- Scaling and high availability
- Connector-specific secrets
- PR preview environments

## Implementation slices

1. Bootstrap remote state and document its recovery procedure.
2. Test the pinned Railway provider against a disposable project, including
   import and update behavior.
3. Provision the sandbox topology and service identities.
4. Port the Paperstand Terraform wrapper and reusable workflow pattern.
5. Add environment-template validation and Railway synchronization.
6. Publish signed commit-addressed images from the public repository.
7. Trigger the private release workflow with image digests.
8. Apply migrations, deploy in order, run smoke checks, and record release state.
9. Prove rollback to the previous manifest.

## Safety requirements

- Resolved secrets never enter Terraform state or workflow logs.
- Terraform and the release workflow do not own the same image-version field.
- Apply operations are not automatically retried after starting.
- Database storage and the Railway project use deletion protection.
- Workflow concurrency prevents two production mutations from racing.

## Verification

- Terraform plan comments update rather than accumulate.
- A code-only merge performs no Terraform apply.
- An infrastructure-only merge does not rebuild application images.
- Railway runs the same image digest published to GHCR.
- A failed smoke check stops the rollout.
- The previous release can be restored without rebuilding.

## Exit gate

Merge a visible version-string change. Confirm the new commit digest is
published, deployed to Railway, reported by the health endpoint, recorded in the
release manifest, and successfully rolled back once.
