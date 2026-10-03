import type { ConnectionRevocation } from "@netrics/contracts";

import { providerName, revocationMessage } from "@/lib/oauth-connection";

/** What a disconnect did with the access at the provider (ADR 0012). */
export function DisconnectResult({
  revocation,
}: {
  revocation: ConnectionRevocation | null;
}) {
  if (!revocation) {
    return null;
  }
  const message = revocationMessage(revocation);
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
            Open your {providerName(revocation.provider)} account permissions
          </a>
        </p>
      ) : null}
    </div>
  );
}
