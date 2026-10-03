import type { ConnectionDetail } from "@netrics/contracts";

import { ConnectOAuthButton } from "./connect-oauth-button";
import { reauthorizationCopy } from "@/lib/oauth-connection";

/**
 * The banner of an OAuth connection whose grant stopped working
 * (needs_reauthorization, ADR 0012), with "Reconnect <provider>" for roles
 * that may update connections.
 */
export function ReconnectBanner({
  workspaceId,
  connection,
  canUpdate,
  returnPath,
}: {
  workspaceId: string;
  connection: ConnectionDetail;
  canUpdate: boolean;
  returnPath: string;
}) {
  if (
    connection.state.authState !== "needs_reauthorization" ||
    !connection.oauth
  ) {
    return null;
  }
  const { provider } = connection.oauth;
  const copy = reauthorizationCopy(connection.state.authReason, provider);
  return (
    <div className="error page-alert" role="alert">
      <p>
        <strong>{copy.title}</strong> {copy.detail}
      </p>
      {canUpdate ? (
        <ConnectOAuthButton
          workspaceId={workspaceId}
          connectorId={connection.connectorId}
          provider={provider}
          connectionId={connection.id}
          returnPath={returnPath}
          offerAccountChange
        />
      ) : (
        <p>Ask a workspace owner, admin or editor to reconnect it.</p>
      )}
    </div>
  );
}
