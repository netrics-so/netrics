# Milestone 02 — Identity and tenancy

## Outcome

A user can create an account, create or enter a workspace, and access only data
belonging to that workspace. A self-hosted installation can bootstrap its first
owner safely.

## Dependencies

- Milestones 00–01

## In scope

- Better Auth adapter and isolated authentication tables
- Email/password login, logout, verification, and password reset
- Netrics domain user mapped to an authentication identity
- Workspace creation and self-hosted first-owner bootstrap
- Memberships with owner, admin, editor, and viewer roles
- Minimal project record and optional active-project selection
- Request authentication and authorization middleware
- PostgreSQL application, migration, and scheduler roles
- Forced RLS on tenant-owned tables
- Transaction-scoped workspace context
- Minimal account and workspace settings UI
- Audit events for login, workspace, and membership changes

## Out of scope

- Invitations, social login, passkeys, 2FA, SAML, OIDC, and SCIM
- Fine-grained project permissions
- Billing and hosted limits
- Connectors and dashboards

## Implementation slices

1. Isolate Better Auth behind server and web adapters.
2. Create domain users, workspaces, memberships, and projects.
3. Implement first-owner bootstrap and normal account creation.
4. Add workspace selection and session-to-domain-user mapping.
5. Implement role permissions in one shared authorization module.
6. Add RLS policies and transaction-scoped workspace context.
7. Add account/workspace settings and audit events.
8. Write adversarial cross-workspace integration tests.

## Security invariants

- Session identity never supplies a trusted workspace ID directly.
- Every tenant query runs inside an explicit workspace transaction.
- The application role cannot bypass or own RLS-protected tables.
- The scheduler role cannot read credential material.
- Workspace ownership cannot be removed without another owner.
- Bootstrap credentials and tokens are single-use.

## Verification

- Each role can perform exactly its documented operations.
- Two users in different workspaces cannot observe identifiers, counts, errors,
  or uniqueness behavior belonging to each other.
- Direct application-role SQL is also restricted by RLS.
- Expired and revoked sessions fail consistently in web and API clients.
- Self-host bootstrap cannot run a second time.

## Exit gate

Create two workspaces with separate owners and projects. Demonstrate permitted
role behavior, then run the cross-workspace API and database test suite with no
leaks.
