"use client";

import type { ConnectionRevocation } from "@netrics/contracts";

import { useLocale, useT } from "@/lib/i18n/client";
import { providerName, revocationMessage } from "@/lib/oauth-connection";

/** What a disconnect did with the access at the provider (ADR 0012). */
export function DisconnectResult({
  revocation,
}: {
  revocation: ConnectionRevocation | null;
}) {
  const locale = useLocale();
  const t = useT("connections.oauth");
  if (!revocation) {
    return null;
  }
  const message = revocationMessage(revocation, locale);
  return (
    <div
      className={`${message.tone} page-alert disconnect-result`}
      role={message.tone === "error" ? "alert" : "status"}
    >
      <p>{message.text}</p>
      {revocation.accountPermissionsUrl && revocation.status !== "revoked" ? (
        <p>
          <a
            href={revocation.accountPermissionsUrl}
            target="_blank"
            rel="noreferrer"
          >
            {t("openPermissions", {
              name: providerName(revocation.provider),
            })}
          </a>
        </p>
      ) : null}
    </div>
  );
}
