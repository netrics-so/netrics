# Milestone 11 — Community connector system

## Outcome

An outside TypeScript developer can build a connector from a template, test it
locally, submit it for review, and have an approved version appear in the
marketplace and hosted connector bundle.

## Dependencies

- Milestones 03 and 05–09

## Why this follows real connectors

The SDK should be extracted from several proven integrations. Publishing it
earlier would freeze guesses and create avoidable compatibility obligations.

## In scope

- Versioned public connector SDK package
- Connector template repository or template directory
- Local fixture runner and mocked credential context
- Contract, pagination, cursor, idempotency, and redaction tests
- Catalog schema with compatibility and declared outbound domains
- Review checklist and contributor documentation
- Dependency, license, secret, and vulnerability checks
- Catalog signing and bundle-generation workflow
- Core-to-SDK compatibility policy
- Marketplace status for bundled, deprecated, and incompatible connectors
- Documented self-host custom-bundle process

## Out of scope

- Arbitrary tenant package upload
- Dynamic npm installation in running workers
- OCI sandbox execution
- Paid connector marketplace

## Implementation slices

1. Stabilize and document SDK v1 from the four production connectors.
2. Extract a minimal connector template and local development command.
3. Package reusable contract and fixture tests.
4. Define catalog metadata, signing, and compatibility rules.
5. Automate bundle generation and marketplace publication.
6. Add review, dependency, and security checks.
7. Document deprecation and emergency-disable procedures.
8. Prove the process with one small community-style sample connector.

## Verification

- The template builds without importing private core packages.
- Connector fixtures run without network access.
- Incompatible SDK versions are rejected at build and startup.
- Marketplace metadata cannot name undeclared code or egress permissions.
- A disabled connector stops new connections while existing data remains
  readable.
- Self-hosters can build and run a custom trusted bundle.

## Exit gate

Build a connector in a clean external repository using only published docs and
packages, submit it through the review pipeline, publish a signed catalog entry,
and enable a connection from the hosted marketplace.
