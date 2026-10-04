import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { LOCALE_NAMES } from "@netrics/domain";

import {
  ChangePasswordForm,
  LanguageForm,
  SignOutButton,
} from "./account-forms";
import { getCurrentMe } from "@/lib/current-user";
import { instanceDefaultLocale, requestLocale } from "@/lib/i18n/locale";
import { getT } from "@/lib/i18n/server";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AccountSettingsPage() {
  await requireSession();
  const [me, t, roles, requestHeaders] = await Promise.all([
    getCurrentMe(),
    getT("account"),
    getT("common.roles"),
    headers(),
  ]);
  if (!me) {
    notFound();
  }
  // What "Automatic" means here: the instance default, else the browser.
  const automatic = requestLocale({
    userLocale: null,
    instanceDefault: instanceDefaultLocale(),
    acceptLanguage: requestHeaders.get("accept-language"),
  });

  return (
    <>
      <h1>{t("title")}</h1>
      <p className="subtitle">{me.user.email}</p>

      <div className="card">
        <h2>{t("profile")}</h2>
        <div className="row">
          <span className="label">{t("name")}</span>
          <span className="value">{me.user.displayName}</span>
        </div>
        <div className="row">
          <span className="label">{t("email")}</span>
          <span className="value">{me.user.email}</span>
        </div>
      </div>

      <div className="card">
        <h2>{t("language.title")}</h2>
        <LanguageForm
          current={me.user.locale}
          automaticName={LOCALE_NAMES[automatic]}
        />
        <p className="muted">{t("language.hint")}</p>
      </div>

      <div className="card">
        <h2>{t("memberships")}</h2>
        {me.memberships.length === 0 ? (
          <p className="muted">{t("noMemberships")}</p>
        ) : (
          me.memberships.map((membership) => (
            <div className="row" key={membership.workspaceId}>
              <span>{membership.workspaceName}</span>
              <span className="role-badge">{roles(membership.role)}</span>
            </div>
          ))
        )}
      </div>

      <div className="card">
        <h2>{t("changePassword")}</h2>
        <ChangePasswordForm />
      </div>

      <div className="card">
        <h2>{t("session")}</h2>
        <SignOutButton />
      </div>
    </>
  );
}
