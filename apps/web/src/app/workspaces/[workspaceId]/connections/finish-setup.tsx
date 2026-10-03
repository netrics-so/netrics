import type {
  ConnectionDetail,
  ConnectorCatalogEntry,
} from "@netrics/contracts";

import { EditConnectionForm } from "./[connectionId]/edit-connection-form";
import { ReconnectBanner } from "./reconnect-banner";
import { SearchConsoleSettings } from "./search-console-settings";
import { SEARCH_CONSOLE_CONNECTOR_ID } from "@/lib/oauth-connection";

/**
 * "Finish setup" for a connection created by an OAuth callback (ADR 0012):
 * it holds the authorization but not its config yet, and is not scheduled
 * until the first config is saved.
 */
export function FinishSetup({
  workspaceId,
  connection,
  connector,
  canUpdate,
  returnPath,
}: {
  workspaceId: string;
  connection: ConnectionDetail;
  connector: ConnectorCatalogEntry | undefined;
  canUpdate: boolean;
  /** Where a reconnect returns to. */
  returnPath: string;
}) {
  return (
    <>
      <ReconnectBanner
        workspaceId={workspaceId}
        connection={connection}
        canUpdate={canUpdate}
        returnPath={returnPath}
      />
      <div className="card" id="finish-setup">
        <h2>Choose what to read</h2>
        {connection.oauth?.accountEmail ? (
          <p className="muted">
            Connected as {connection.oauth.accountEmail}. Nothing is synced
            until you save.
          </p>
        ) : (
          <p className="muted">Nothing is synced until you save.</p>
        )}
        {!canUpdate ? (
          <p className="muted">
            Your role cannot change connections. Ask a workspace owner, admin or
            editor to finish the setup.
          </p>
        ) : connection.connectorId === SEARCH_CONSOLE_CONNECTOR_ID ? (
          <SearchConsoleSettings
            workspaceId={workspaceId}
            connection={connection}
            connectorName={connector?.name ?? connection.connectorName}
            mode="finish"
          />
        ) : (
          <EditConnectionForm
            workspaceId={workspaceId}
            connection={connection}
            connector={connector}
          />
        )}
      </div>
    </>
  );
}
