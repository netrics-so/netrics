"use client";

import type {
  ConnectionDetail,
  ConnectorCatalogEntry,
} from "@netrics/contracts";

import { EditConnectionForm } from "./[connectionId]/edit-connection-form";
import { ReconnectBanner } from "./reconnect-banner";
import { SearchConsoleSettings } from "./search-console-settings";
import { useT } from "@/lib/i18n/client";
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
  const t = useT("connections.finishSetup");
  return (
    <>
      <ReconnectBanner
        workspaceId={workspaceId}
        connection={connection}
        canUpdate={canUpdate}
        returnPath={returnPath}
      />
      <div className="card" id="finish-setup">
        <h2>{t("title")}</h2>
        {connection.oauth?.accountEmail ? (
          <p className="muted">
            {t("connectedAs", { email: connection.oauth.accountEmail })}
          </p>
        ) : (
          <p className="muted">{t("nothingSynced")}</p>
        )}
        {!canUpdate ? (
          <p className="muted">{t("roleCannot")}</p>
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
