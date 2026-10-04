import Link from "next/link";

import { getCurrentMe } from "@/lib/current-user";
import { getT } from "@/lib/i18n/server";

export async function Nav() {
  const [me, t] = await Promise.all([getCurrentMe(), getT("nav")]);
  const user = me?.user;

  return (
    <header className="container nav">
      <Link href="/" className="nav-brand">
        <span className="brand-dot" aria-hidden="true" />
        netrics
      </Link>
      <nav className="nav-links">
        <Link href="/status">{t("status")}</Link>
        {user ? (
          <Link href="/settings/account" title={t("account")}>
            {user.displayName}
          </Link>
        ) : (
          <Link href="/login">{t("signIn")}</Link>
        )}
      </nav>
    </header>
  );
}
