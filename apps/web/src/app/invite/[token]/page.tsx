import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";

import { InvitationActions } from "./invitation-actions";
import { getInvitationPreview } from "@/lib/api";
import { getT } from "@/lib/i18n/server";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("invite");
  return { title: `${t("accept")} · netrics` };
}

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const preview = await getInvitationPreview(token);
  const [t, roles] = await Promise.all([getT("invite"), getT("common.roles")]);

  if (!preview) {
    return (
      <>
        <h1>{t("notFoundTitle")}</h1>
        <p className="subtitle">{t("notFoundText")}</p>
      </>
    );
  }
  if (preview.status !== "pending") {
    return (
      <>
        <h1>{t("title", { workspace: preview.workspaceName })}</h1>
        <p className="subtitle">{t(preview.status)}</p>
        <p className="muted">
          <Link href="/login">{t("signIn")}</Link>
        </p>
      </>
    );
  }

  const cookieHeader = (await headers()).get("cookie") ?? "";
  const user = await getSessionUser(cookieHeader);

  return (
    <>
      <h1>{t("title", { workspace: preview.workspaceName })}</h1>
      <p className="subtitle">
        {t.rich("invitedAs", {
          role: (
            <span key="role" className="role-badge">
              {roles(preview.role)}
            </span>
          ),
          email: preview.email,
        })}
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
          {t.rich("haveAccount", {
            email: preview.email,
            link: (
              <Link
                key="link"
                href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}
              >
                {t("signIn")}
              </Link>
            ),
          })}
        </p>
      )}
    </>
  );
}
