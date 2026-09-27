import { headers } from "next/headers";
import Link from "next/link";

import { InvitationActions } from "./invitation-actions";
import { getInvitationPreview } from "@/lib/api";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const STATUS_MESSAGES = {
  accepted: "This invitation has already been used.",
  revoked: "This invitation was withdrawn. Ask for a new one.",
  expired: "This invitation has expired. Ask for a new one.",
} as const;

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const preview = await getInvitationPreview(token);

  if (!preview) {
    return (
      <>
        <h1>Invitation not found</h1>
        <p className="subtitle">
          This link is not valid. Check that you copied it completely.
        </p>
      </>
    );
  }
  if (preview.status !== "pending") {
    return (
      <>
        <h1>Join {preview.workspaceName}</h1>
        <p className="subtitle">{STATUS_MESSAGES[preview.status]}</p>
        <p className="muted">
          <Link href="/login">Sign in</Link>
        </p>
      </>
    );
  }

  const cookieHeader = (await headers()).get("cookie") ?? "";
  const user = await getSessionUser(cookieHeader);

  return (
    <>
      <h1>Join {preview.workspaceName}</h1>
      <p className="subtitle">
        You were invited as <span className="role-badge">{preview.role}</span>{" "}
        with {preview.email}.
      </p>
      <div className="card">
        <InvitationActions
          token={token}
          invitedEmail={preview.email}
          signedInEmail={user?.email ?? null}
        />
      </div>
      {user ? null : (
        <p className="muted">
          Already have an account for {preview.email}?{" "}
          <Link href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>
            Sign in
          </Link>
        </p>
      )}
    </>
  );
}
