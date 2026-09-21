# Milestone 14 — Collaboration and access

## Outcome

Netrics has complete v1 collaboration, sharing, identity, and administrative
capabilities for small teams and enterprise identity environments.

## Dependencies

- Milestones 02, 04, and 13

## In scope

- Workspace invitation, acceptance, expiration, resend, and removal
- Role-management UI and ownership transfer
- Social login, passkeys, and two-factor authentication
- Generic OIDC identity-provider configuration
- SAML service-provider configuration
- SCIM user and group provisioning
- Secure external-identity linking and domain verification
- Revocable dashboard share links
- Embed policy and origin restrictions
- Comprehensive audit-log viewer and export
- Instance settings for SMTP, storage, retention, and identity
- Workspace export and deletion workflow

## Out of scope

- Project-specific memberships
- Custom roles beyond the four v1 roles
- Public connector installation by viewers
- White-labeling

## Implementation slices

1. Finish invitations, role changes, ownership transfer, and removal.
2. Add social providers, passkeys, 2FA, recovery, and session management.
3. Add generic OIDC configuration and domain verification.
4. Add SAML metadata, signing, assertion validation, and admin setup.
5. Add SCIM tokens, provisioning, group mapping, and deprovisioning.
6. Add public sharing, embed origin policy, and revocation.
7. Complete audit viewer, export, instance settings, and deletion workflows.
8. Perform account-linking and enterprise-identity security tests.

## Security invariants

- Email address alone never links external identities.
- Domain-based membership requires verified domain ownership.
- SAML and OIDC identities use stable issuer and subject pairs.
- SCIM credentials are scoped, hashed or encrypted appropriately, and rotatable.
- Share tokens are high entropy, scoped, revocable, and absent from referrers.
- Workspace deletion requires reauthentication and a recoverable grace period.

## Verification

- Invitation and role flows enforce the permission matrix.
- Passkey, 2FA recovery, session revocation, and account linking are tested.
- OIDC and SAML work with at least one real provider each.
- SCIM create, update, deactivate, group mapping, and replay cases pass.
- Shared links and embeds expose only the intended dashboard.
- Audit entries explain every security-sensitive change.

## Exit gate

Invite and manage a team, authenticate through passkey and enterprise SSO,
provision a user through SCIM, share and revoke a dashboard, and export the
resulting audit history.
