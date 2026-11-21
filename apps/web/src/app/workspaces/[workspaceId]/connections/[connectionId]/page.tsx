import Link from "next/link";
import { notFound } from "next/navigation";

import { can, localizedProviderMessage } from "@netrics/domain";

import { HealthBadge, RateLimitText } from "../../health-badge";
import { FinishSetup } from "../finish-setup";
import { OAuthOutcomeBanner } from "../oauth-outcome";
import { ReconnectBanner } from "../reconnect-banner";
import { StoreConnectionSettings } from "../store-connection-settings";
import { SearchConsoleSettings } from "../search-console-settings";
import { ConnectionActions } from "./connection-actions";
import { HistoryReload } from "./history-reload";
import { EditConnectionForm } from "./edit-connection-form";
import { AppStoreAnalyticsPanel } from "./app-store-analytics-panel";
import { AppStoreReviewsPanel } from "./app-store-reviews-panel";
import { AddAdAccountPanel } from "./add-ad-account-panel";
import { SignedKeyPanel } from "./signed-key-panel";
import { RetentionSettings } from "./retention-settings";
import { ConnectionProject } from "./connection-project";
import { ConnectionFreshness } from "./connection-freshness";
import { ConnectionItemImages } from "./connection-item-images";
import { SyncRunError } from "./sync-run-error";
import { ConnectionRefresh } from "./connection-refresh";
import { waitsForSync } from "./wait-for-sync";
import { CustomApiConnectionLogin } from "@/components/custom-api/connection-login";
import { CustomApiUpdateBanner } from "@/components/custom-api/connection-update-review";
import {
  getConnection,
  getConnectionRetention,
  getCustomApiDefinitionVersion,
  getWorkspace,
  listConnectors,
  listObservations,
  listProjects,
  listWorkspaceMetrics,
  listWorkspaces,
} from "@/lib/api";
import { connectorVersionLabel } from "@/lib/custom-api";
import { getDataSources } from "@/lib/data-api";
import { getLocale, getT } from "@/lib/i18n/server";
import {
  parseOAuthOutcome,
  providerName,
  SEARCH_CONSOLE_CONNECTOR_ID,
} from "@/lib/oauth-connection";
import { observationBreakdown } from "@/lib/format-metric";
import { formatReportingDay } from "@/lib/app-store-analytics";
import { intervalLabel, relativeTime } from "@/lib/relative-time";
import { requireSession } from "@/lib/session";
import { appleAdsConnectionAccount, listNames } from "@/lib/apple-ads";
import {
  APP_STORE_CONNECT_CONNECTOR_ID,
  APP_STORE_CONNECT_DOCS_URL,
  APPLE_ADS_CONNECTOR_ID,
  APPLE_ADS_DOCS_URL,
  latestReportingDay,
  signedKeyStrategyOf,
} from "@/lib/signed-key";
import { nextSyncLabel } from "@/lib/sync-schedule";

export const dynamic = "force-dynamic";

interface ConnectionDetailPageProps {
  params: Promise<{ workspaceId: string; connectionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function shortWindow(from: string, to: string): string {
  return `${from.slice(0, 10)} → ${to.slice(0, 10)}`;
}

export default async function ConnectionDetailPage({
  params,
  searchParams,
}: ConnectionDetailPageProps) {
  const { workspaceId, connectionId } = await params;
  const query = await searchParams;
  const { forwarded } = await requireSession();
  const locale = await getLocale();
  const t = await getT("connections.detail");
  const stores = await getT("storeTemplate");
  const ads = await getT("connections.appleAds");
  const health = await getT("health");
  const retentionT = await getT("connections.retention");
  const historyT = await getT("connections.history");
  const loginT = await getT("customApi.connectionLogin");
  const updateT = await getT("customApi.update");

  const [{ workspaces }, workspaceResult, detail] = await Promise.all([
    listWorkspaces(forwarded),
    getWorkspace(forwarded, workspaceId),
    getConnection(forwarded, workspaceId, connectionId),
  ]);
  const membership = workspaces.find((w) => w.id === workspaceId);
  if (!workspaceResult || !membership || !detail) {
    notFound();
  }
  const role = membership.role;
  const { connection, syncRuns, history } = detail;

  const [
    { connectors },
    { observations },
    { observations: changed },
    { metrics },
    retentionResult,
    { projects },
  ] = await Promise.all([
    listConnectors(forwarded),
    listObservations(forwarded, workspaceId, connectionId, { limit: 100 }),
    // The list leaves out values of 0 (#623): days without downloads or
    // reviews would otherwise bury the values that changed.
    listObservations(forwarded, workspaceId, connectionId, {
      limit: 100,
      nonZero: true,
    }),
    listWorkspaceMetrics(forwarded, workspaceId),
    getConnectionRetention(forwarded, workspaceId, connectionId),
    listProjects(forwarded, workspaceId),
  ]);
  // Dataset retention (#492), for connectors that collect data tables.
  const retention =
    retentionResult && retentionResult.retention.datasets.length > 0
      ? retentionResult.retention
      : null;
  // Metric names for the observations table (the key stays in the tooltip).
  const metricNames = new Map(
    metrics
      .filter((metric) => metric.connectionId === connectionId)
      .map((metric) => [metric.key, metric.name]),
  );
  // Breakdown dimension names in the viewer's language, from the API.
  const dimensionNames: Record<string, string> = Object.assign(
    {},
    ...metrics
      .filter((metric) => metric.connectionId === connectionId)
      .map((metric) => metric.dimensionNames),
  );
  // Resource names for the freshness entries reported per app (ADR 0025).
  const resourceNames: Record<string, string> = Object.fromEntries(
    observations.flatMap((observation) =>
      observation.resourceName && observation.dimensions.resource
        ? [[observation.dimensions.resource, observation.resourceName]]
        : [],
    ),
  );
  // A custom API connection (#808): its pinned version's login method and
  // secret values for the login panel, and the offered update.
  const customApi = connection.customApi;
  const pinnedVersion = customApi
    ? await getCustomApiDefinitionVersion(
        forwarded,
        workspaceId,
        customApi.definitionId,
        customApi.version,
      )
    : null;
  const connector = connectors.find((c) => c.id === connection.connectorId);
  // A custom API stores records in datasets, never observations (#834):
  // its page lists the datasets with their rows instead.
  const customApiDatasets =
    customApi && can(role, "data:preview")
      ? (await getDataSources(workspaceId, forwarded).catch(() => [])).filter(
          (source) =>
            source.connectionId === connectionId && source.kind === "source",
        )
      : [];
  // Streams without a time window read everything: their runs have none.
  const windowless =
    pinnedVersion?.document.streams.every(
      (stream) => stream.window.type === "none",
    ) ?? false;
  const canUpdate = can(role, "connections:update");
  const authFailed = connection.state.authState === "auth_failed";
  // A sync can only fail until the grant is reconnected (the API refuses it).
  const needsReconnect = connection.state.authState === "needs_reauthorization";
  const recordedAuthMessage = syncRuns.find(
    (run) => run.errorClass === "auth",
  )?.errorMessage;
  // A refusal the catalog knows reads in the viewer's language (#378);
  // other provider words stay as they came.
  const authMessage = recordedAuthMessage
    ? (localizedProviderMessage(recordedAuthMessage, locale) ??
      recordedAuthMessage)
    : undefined;
  const oauth = connection.oauth;
  const searchConsole = connection.connectorId === SEARCH_CONSOLE_CONNECTOR_ID;
  const returnPath = `/workspaces/${workspaceId}/connections/${connection.id}`;
  // A connection with an uploaded key (ADR 0014): rotation and revocation.
  const keyStrategy = oauth ? null : signedKeyStrategyOf(connector);
  const keyName = keyStrategy?.providerName ?? connection.connectorName;
  const appStore = connection.connectorId === APP_STORE_CONNECT_CONNECTOR_ID;
  const latestDay = appStore ? latestReportingDay(observations) : null;
  // Apple Ads (#375): one ad account per connection, with its currency and
  // time zone in the config.
  const appleAds = connection.connectorId === APPLE_ADS_CONNECTOR_ID;
  const adAccount = appleAds
    ? appleAdsConnectionAccount(connection.config)
    : null;
  const numbers = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 });
  // The provider's request limit holds (#781): syncing continues after it.
  const rateLimitedUntil = connection.state.rateLimitedUntil ?? null;
  // History status (#617): a backfill waits or runs, or datasets that no
  // backfill has read yet (added by a connector update) hold partial history.
  const historyLoading =
    !connection.setupPending && history.backfill !== "idle";
  const incompleteNames = listNames(
    history.incompleteDatasets.map((dataset) => dataset.name),
    locale,
  );
  const canReloadHistory =
    canUpdate &&
    history.supportsBackfill &&
    !connection.setupPending &&
    !needsReconnect;

  return (
    <>
      <ConnectionRefresh
        active={waitsForSync({
          setupPending: connection.setupPending,
          loginMissing: customApi?.loginMissing ?? false,
          health: connection.state.health,
          backfill: history.backfill,
          runs: syncRuns,
        })}
      />
      <h1>{connection.name}</h1>
      <p className="subtitle">
        {connection.connectorName} {connectorVersionLabel(connection)} ·{" "}
        <HealthBadge
          health={connection.state.health}
          rateLimitedUntil={rateLimitedUntil}
          connectorName={connection.connectorName}
        />
      </p>
      <p className="muted">
        <Link href={`/workspaces/${workspaceId}/sources`}>{t("back")}</Link>
      </p>

      <OAuthOutcomeBanner
        outcome={parseOAuthOutcome(query.oauth)}
        {...(oauth ? { provider: oauth.provider } : {})}
      />
      {customApi && typeof query.updated === "string" ? (
        <div className="notice page-alert" role="status">
          {updateT("done", { version: customApi.version })}
        </div>
      ) : null}
      {query.setup === "finished" && !connection.setupPending ? (
        <div className="notice page-alert" role="status">
          {t("setupFinished")}
        </div>
      ) : null}

      {!connection.setupPending &&
      (appStore || connection.connectorId === "google-play") &&
      can(role, "dashboards:create") &&
      can(role, "data:publish") ? (
        <div className="card stack">
          <h2>{stores("title")}</h2>
          <p className="muted">{stores("subtitle")}</p>
          <div className="actions">
            <Link
              className="button primary"
              href={`/workspaces/${workspaceId}/dashboards/stores?connection=${connection.id}`}
            >
              {stores("appDashboard")}
            </Link>
          </div>
        </div>
      ) : null}
      {connection.setupPending && !customApi ? (
        <FinishSetup
          workspaceId={workspaceId}
          connection={connection}
          connector={connector}
          canUpdate={canUpdate}
          returnPath={returnPath}
        />
      ) : (
        // A custom API's OAuth sign-in lives in its login panel.
        !customApi && (
          <ReconnectBanner
            workspaceId={workspaceId}
            connection={connection}
            canUpdate={canUpdate}
            returnPath={returnPath}
          />
        )
      )}

      {customApi?.updateAvailable ? (
        <CustomApiUpdateBanner
          workspaceId={workspaceId}
          connectionId={connection.id}
          name={pinnedVersion?.document.name ?? connection.name}
          version={customApi.currentVersion}
          canUpdate={canUpdate}
        />
      ) : null}
      {customApi && pinnedVersion && canUpdate ? (
        <CustomApiConnectionLogin
          workspaceId={workspaceId}
          connection={connection}
          method={pinnedVersion.document.auth.type}
          variables={pinnedVersion.document.variables}
        />
      ) : null}

      {historyLoading ? (
        <div className="notice page-alert" role="status">
          {historyT("loading")}
        </div>
      ) : history.incompleteDatasets.length > 0 ? (
        <div className="notice page-alert" role="status">
          {canReloadHistory
            ? historyT("incomplete", { datasets: incompleteNames })
            : historyT("incompleteReadOnly", { datasets: incompleteNames })}
        </div>
      ) : null}

      {authFailed ? (
        <div className="error page-alert" role="alert">
          <p>
            <strong>{t("pausedCredentials")}</strong> {authMessage ?? ""}
          </p>
          <p>
            {keyStrategy ? (
              canUpdate ? (
                appleAds ? (
                  <>
                    <a href="#replace-key">{ads("setUpNewKey")}</a>{" "}
                    {ads("setUpNewKeyDetail")}
                  </>
                ) : (
                  <>
                    <a href="#replace-key">
                      {t("uploadNewKey", { name: keyName })}
                    </a>{" "}
                    {t("uploadNewKeyDetail")}
                  </>
                )
              ) : (
                t("askUploadKey", { name: keyName })
              )
            ) : oauth ? (
              searchConsole ? (
                t("restoreSearchConsole")
              ) : (
                t("checkProviderPermissions")
              )
            ) : canUpdate ? (
              <>
                <a href={customApi ? "#custom-api-login" : "#edit-connection"}>
                  {customApi ? loginT("enterAgain") : t("enterToken")}
                </a>{" "}
                {t("enterTokenDetail")}
              </>
            ) : (
              t("askUpdateCredentials")
            )}
          </p>
        </div>
      ) : null}

      <div className="card">
        <h2>{t("health")}</h2>
        <div className="row">
          <span className="label">{t("authState")}</span>
          <span className="value">
            {health(`authStates.${connection.state.authState}`)}
          </span>
        </div>
        {rateLimitedUntil ? (
          <div className="row">
            <span className="label">{t("rateLimit")}</span>
            <span className="value">
              <RateLimitText
                rateLimitedUntil={rateLimitedUntil}
                connectorName={connection.connectorName}
              />
            </span>
          </div>
        ) : null}
        <div className="row">
          <span className="label">{t("consecutiveFailures")}</span>
          <span className="value">{connection.state.consecutiveFailures}</span>
        </div>
        <div className="row">
          <span className="label">{t("lastSuccess")}</span>
          <span className="value">
            {relativeTime(connection.state.lastSuccessAt, locale)}
          </span>
        </div>
        <div className="row">
          <span className="label">{t("nextSync")}</span>
          <span className="value">
            {nextSyncLabel(connection.state, locale)}
          </span>
        </div>
        <div className="row">
          <span className="label">{t("pollInterval")}</span>
          <span className="value">
            {intervalLabel(connection.state.pollIntervalSeconds, locale)}
          </span>
        </div>
        {oauth ? (
          <div className="row">
            <span className="label">
              {t("providerAccount", { provider: providerName(oauth.provider) })}
            </span>
            <span className="value">
              {oauth.accountEmail
                ? t("connectedAs", { email: oauth.accountEmail })
                : t("connected")}
            </span>
          </div>
        ) : (
          <div className="row">
            <span className="label">{t("credentials")}</span>
            <span className="value">
              {connection.hasCredentials
                ? t("credentialsStored")
                : t("credentialsNone")}
            </span>
          </div>
        )}
        <ConnectionActions
          workspaceId={workspaceId}
          connectionId={connection.id}
          connectionName={connection.name}
          oauthProvider={oauth?.provider ?? null}
          signedKey={
            keyStrategy
              ? {
                  provider: keyStrategy.provider,
                  providerName: keyName,
                  revokeUrl: keyStrategy.setup?.url ?? null,
                  keyId:
                    connection.signedKey?.fields.find(
                      (field) => field.key === "keyId",
                    )?.value ?? null,
                  sharedWith: (connection.signedKey?.sharedWith ?? []).map(
                    (other) => other.name,
                  ),
                }
              : null
          }
          canSync={!connection.setupPending && !needsReconnect}
          canUpdate={canUpdate}
          canDelete={can(role, "connections:delete")}
        />
        {canReloadHistory ? (
          <HistoryReload
            workspaceId={workspaceId}
            connectionId={connection.id}
            connectionName={connection.name}
            history={history}
          />
        ) : null}
      </div>

      <ConnectionFreshness
        streams={detail.freshness}
        nextCheckAt={connection.state.nextDueAt}
        authState={connection.state.authState}
        resourceNames={resourceNames}
      />

      {detail.itemImages ? (
        <ConnectionItemImages streams={detail.itemImages} />
      ) : null}

      {keyStrategy ? (
        <SignedKeyPanel
          workspaceId={workspaceId}
          connectionId={connection.id}
          strategy={keyStrategy}
          signedKey={connection.signedKey}
          hasCredentials={connection.hasCredentials}
          authFailed={authFailed}
          canUpdate={canUpdate}
        />
      ) : null}

      {adAccount ? (
        <div className="card">
          <h2>{ads("accountTitle")}</h2>
          <div className="row">
            <span className="label">{ads("adAccount")}</span>
            <span className="value">
              {adAccount.name ?? ads("unknown")}
              {adAccount.id ? (
                <>
                  {" "}
                  <code>{adAccount.id}</code>
                </>
              ) : null}
            </span>
          </div>
          <div className="row">
            <span className="label">{ads("currency")}</span>
            <span className="value">
              {adAccount.currency ?? ads("unknown")}
            </span>
          </div>
          <div className="row">
            <span className="label">{ads("timeZone")}</span>
            <span className="value">
              {adAccount.timeZone ?? ads("unknown")}
            </span>
          </div>
          {adAccount.timeZone ? (
            <p className="muted">
              {ads("daysLabel", { timeZone: adAccount.timeZone })}{" "}
              {adAccount.currency
                ? ads("currencyNote", { currency: adAccount.currency })
                : null}{" "}
              {ads("compareHint")}
            </p>
          ) : null}
          <p className="muted">
            {ads("timing")}{" "}
            <a href={APPLE_ADS_DOCS_URL} target="_blank" rel="noreferrer">
              {ads("moreAboutConnector")}
            </a>
          </p>
        </div>
      ) : null}

      {adAccount &&
      keyStrategy &&
      connection.hasCredentials &&
      !connection.setupPending &&
      can(role, "connections:create") ? (
        <AddAdAccountPanel
          workspaceId={workspaceId}
          connectionId={connection.id}
          projectId={membership.activeProjectId}
        />
      ) : null}

      {appStore && keyStrategy && !connection.setupPending ? (
        <AppStoreAnalyticsPanel
          workspaceId={workspaceId}
          connectionId={connection.id}
          strategy={keyStrategy}
          issuerId={
            connection.signedKey?.fields.find(
              (field) => field.key === "issuerId",
            )?.value ?? null
          }
          canUpdate={canUpdate}
          authFailed={authFailed}
        />
      ) : null}

      {appStore && keyStrategy && !connection.setupPending ? (
        <AppStoreReviewsPanel
          workspaceId={workspaceId}
          connectionId={connection.id}
          strategy={keyStrategy}
          canUpdate={canUpdate}
        />
      ) : null}

      {appStore ? (
        <div className="card">
          <h2>{t("appStoreAbout")}</h2>
          <div className="row">
            <span className="label">{t("latestReportingDay")}</span>
            <span className="value">
              {latestDay ? formatReportingDay(latestDay, locale) : t("noneYet")}
            </span>
          </div>
          <p className="muted">
            {t("appStoreTiming")}{" "}
            <a
              href={APP_STORE_CONNECT_DOCS_URL}
              target="_blank"
              rel="noreferrer"
            >
              {t("moreAboutConnector")}
            </a>
          </p>
        </div>
      ) : null}

      {searchConsole ? (
        <div className="card">
          <h2>{t("searchConsoleAbout")}</h2>
          <p className="muted">{t("searchConsoleTiming")}</p>
          <p className="muted">
            {t("searchConsolePrivacy")}{" "}
            <a
              href="https://github.com/netrics-so/netrics/blob/main/docs/connectors/google-search-console.md"
              target="_blank"
              rel="noreferrer"
            >
              {t("moreAboutConnector")}
            </a>
          </p>
        </div>
      ) : null}

      {canUpdate && !connection.setupPending ? (
        <div className="card" id="edit-connection">
          <h2>{t("editConnection")}</h2>
          {projects.length > 0 || connection.projectId !== null ? (
            <ConnectionProject
              workspaceId={workspaceId}
              connectionId={connection.id}
              projectId={connection.projectId}
              projects={projects.map(({ id, name, archivedAt }) => ({
                id,
                name,
                archivedAt,
              }))}
            />
          ) : null}
          {searchConsole ? (
            <SearchConsoleSettings
              workspaceId={workspaceId}
              connection={connection}
              connectorName={connector?.name ?? connection.connectorName}
              mode="edit"
            />
          ) : connector?.supportsResourceSelection ? (
            <StoreConnectionSettings
              workspaceId={workspaceId}
              connection={connection}
              connector={connector}
            />
          ) : (
            <EditConnectionForm
              workspaceId={workspaceId}
              connection={connection}
              connector={connector}
            />
          )}
        </div>
      ) : null}

      {retention ? (
        <div className="card" id="retention">
          <h2>{retentionT("title")}</h2>
          <RetentionSettings
            workspaceId={workspaceId}
            connectionId={connection.id}
            retention={retention}
            canUpdate={canUpdate}
            setup={connection.setupPending}
          />
        </div>
      ) : null}

      <div className="card">
        <h2>{t("syncRuns")}</h2>
        {syncRuns.length === 0 ? (
          <p className="muted">
            {connection.setupPending ? t("nothingSyncs") : t("noRuns")}
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t("runs.status")}</th>
                <th>{t("runs.mode")}</th>
                <th>{t("runs.window")}</th>
                {customApi ? null : <th>{t("runs.observations")}</th>}
                <th>{t("runs.attempt")}</th>
                <th>{t("runs.error")}</th>
                <th>{t("runs.started")}</th>
                <th>{t("runs.finished")}</th>
              </tr>
            </thead>
            <tbody>
              {syncRuns.map((run) => (
                <tr key={run.id}>
                  <td>{t(`runStatus.${run.status}`)}</td>
                  <td>{t(`runMode.${run.mode}`)}</td>
                  <td className="muted">
                    {windowless
                      ? "—"
                      : shortWindow(run.requestedFrom, run.requestedTo)}
                  </td>
                  {customApi ? null : <td>{run.observationsWritten}</td>}
                  <td>{run.attempt}</td>
                  <td className="muted">
                    <SyncRunError run={run} />
                  </td>
                  <td className="muted">
                    {relativeTime(run.startedAt, locale)}
                  </td>
                  <td className="muted">
                    {relativeTime(run.finishedAt, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {((connector?.datasetsCount ?? 0) > 0 || customApi) &&
      can(role, "data:preview") ? (
        <div className="card">
          <h2>{t("dataTables")}</h2>
          <p className="muted">{t("dataTablesHelp")}</p>
          {customApi ? (
            customApiDatasets.length ? (
              <ul>
                {customApiDatasets.map((dataset) => (
                  <li key={dataset.id}>
                    {dataset.name}
                    {dataset.rowCount !== null
                      ? ` · ${t("datasetRows", { count: dataset.rowCount })}`
                      : ""}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">{t("noRecords")}</p>
            )
          ) : null}
          <Link href={`/workspaces/${workspaceId}/data`}>{t("openData")}</Link>
        </div>
      ) : null}
      {connector?.metricsCount !== 0 && !customApi ? (
        <div className="card">
          <h2>{t("latestObservations")}</h2>
          {observations.length === 0 ? (
            <p className="muted">{t("noObservations")}</p>
          ) : changed.length === 0 ? (
            <p className="muted">{t("onlyZeroObservations")}</p>
          ) : (
            <>
              <p className="muted">{t("zeroObservationsHidden")}</p>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("observations.metric")}</th>
                    <th>{t("observations.resource")}</th>
                    <th>{t("observations.breakdown")}</th>
                    <th>{t("observations.day")}</th>
                    <th>{t("observations.value")}</th>
                  </tr>
                </thead>
                <tbody>
                  {changed.map((observation) => (
                    <tr
                      key={`${observation.metricKey}/${observation.seriesKey}/${observation.sourceTimestamp}`}
                    >
                      <td title={observation.metricKey}>
                        {metricNames.get(observation.metricKey) ??
                          observation.metricKey}
                      </td>
                      <td
                        className="muted"
                        title={
                          observation.resourceName
                            ? observation.dimensions.resource
                            : undefined
                        }
                      >
                        {observation.resourceName ??
                          observation.dimensions.resource ??
                          "—"}
                      </td>
                      <td>
                        {observationBreakdown(observation.dimensions).map(
                          ([dimension, value]) => (
                            <div key={dimension}>
                              <span className="muted">
                                {dimensionNames[dimension] ?? dimension}
                              </span>{" "}
                              {value}
                            </div>
                          ),
                        )}
                      </td>
                      <td className="muted nowrap">
                        {observation.sourceTimestamp.slice(0, 10)}
                      </td>
                      <td className="nowrap">
                        {numbers.format(observation.value)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      ) : null}
    </>
  );
}
