import { notFound } from "next/navigation";

import { ChangePasswordForm, SignOutButton } from "./account-forms";
import { getMe } from "@/lib/api";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AccountSettingsPage() {
  const { cookieHeader } = await requireSession();
  const me = await getMe(cookieHeader);
  if (!me) {
    notFound();
  }

  return (
    <>
      <h1>Account</h1>
      <p className="subtitle">{me.user.email}</p>

      <div className="card">
        <h2>Profile</h2>
        <div className="row">
          <span className="label">Name</span>
          <span className="value">{me.user.displayName}</span>
        </div>
        <div className="row">
          <span className="label">Email</span>
          <span className="value">{me.user.email}</span>
        </div>
      </div>

      <div className="card">
        <h2>Workspace memberships</h2>
        {me.memberships.length === 0 ? (
          <p className="muted">No memberships yet.</p>
        ) : (
          me.memberships.map((membership) => (
            <div className="row" key={membership.workspaceId}>
              <span>{membership.workspaceName}</span>
              <span className="role-badge">{membership.role}</span>
            </div>
          ))
        )}
      </div>

      <div className="card">
        <h2>Change password</h2>
        <ChangePasswordForm />
      </div>

      <div className="card">
        <h2>Session</h2>
        <SignOutButton />
      </div>
    </>
  );
}
