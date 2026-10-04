"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import type { ConnectionDetail } from "@netrics/contracts";

import {
  ApiError,
  apiErrorMessage,
  listConnectionResources,
  updateConnection,
} from "@/lib/api";
import {
  DEFAULT_ROW_LIMIT,
  DIMENSION_LABELS,
  MAX_BREAKDOWN_DIMENSIONS,
  MAX_ROW_LIMIT,
  SEARCH_CONSOLE_DIMENSIONS,
  fromDimensionsValue,
  parseRowLimit,
  propertyView,
  toDimensionsValue,
  type PropertyView,
  type SearchConsoleDimension,
} from "@/lib/oauth-connection";
import { useLocale } from "@/lib/i18n/client";

interface SearchConsoleSettingsProps {
  workspaceId: string;
  connection: ConnectionDetail;
  connectorName: string;
  /** "finish": the first config of a new connection; "edit": later changes. */
  mode: "finish" | "edit";
}

type Properties =
  | { status: "loading" }
  | { status: "error"; message: string; reconnect: boolean }
  | { status: "ready"; properties: PropertyView[] };

/**
 * The Search Console property, breakdown and rows per day of a connection.
 * Properties come from the discovery route, which asks Google with the
 * connection's own authorization; saving runs the connector check, and for
 * a new connection it starts the first sync (ADR 0012).
 */
export function SearchConsoleSettings({
  workspaceId,
  connection,
  connectorName,
  mode,
}: SearchConsoleSettingsProps) {
  const locale = useLocale();
  const router = useRouter();
  const config = connection.config;
  const [properties, setProperties] = useState<Properties>({
    status: "loading",
  });
  const [siteUrl, setSiteUrl] = useState(
    typeof config.siteUrl === "string" ? config.siteUrl : "",
  );
  const [dimensions, setDimensions] = useState<SearchConsoleDimension[]>(() =>
    fromDimensionsValue(config.dimensions),
  );
  const [rowLimit, setRowLimit] = useState(
    String(
      typeof config.rowLimit === "number" ? config.rowLimit : DEFAULT_ROW_LIMIT,
    ),
  );
  const [name, setName] = useState(connection.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const needsReconnect = connection.state.authState === "needs_reauthorization";

  useEffect(() => {
    if (needsReconnect) {
      // Google would refuse the stored authorization; reconnect first.
      setProperties({ status: "error", message: "", reconnect: true });
      return;
    }
    let cancelled = false;
    listConnectionResources(workspaceId, connection.id)
      .then(({ resources }) => {
        if (cancelled) {
          return;
        }
        const views = resources.map(propertyView);
        setProperties({ status: "ready", properties: views });
        // One property: nothing to choose.
        setSiteUrl((current) =>
          current === "" && views.length === 1 ? views[0]!.siteUrl : current,
        );
      })
      .catch((cause: unknown) => {
        if (cancelled) {
          return;
        }
        const reconnect =
          cause instanceof ApiError &&
          cause.code === "oauth_reauthorization_required";
        setProperties({
          status: "error",
          message: apiErrorMessage(cause, locale),
          reconnect,
        });
        if (reconnect) {
          // The page shows the reconnect banner for the new state.
          router.refresh();
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, connection.id, needsReconnect, router]);

  function toggleDimension(dimension: SearchConsoleDimension) {
    setDimensions((current) =>
      current.includes(dimension)
        ? current.filter((entry) => entry !== dimension)
        : [...current, dimension],
    );
  }

  const listed = properties.status === "ready" ? properties.properties : [];
  const chosen = listed.find((property) => property.siteUrl === siteUrl);
  // A stored property the account no longer lists stays selectable.
  const unlisted = siteUrl !== "" && !chosen && properties.status === "ready";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (siteUrl === "") {
      setError("Choose a Search Console property.");
      return;
    }
    const limit = parseRowLimit(rowLimit);
    if (dimensions.length > 0 && limit === null) {
      setError(
        `Rows per day must be a whole number from 1 to ${MAX_ROW_LIMIT.toLocaleString("en-US")}.`,
      );
      return;
    }
    const nextName =
      mode === "finish"
        ? connection.name === connectorName && chosen
          ? `Search Console: ${chosen.name}`
          : connection.name
        : name.trim();
    const nextConfig = {
      siteUrl,
      dimensions: toDimensionsValue(dimensions),
      ...(dimensions.length > 0 && limit !== null ? { rowLimit: limit } : {}),
    };
    // The server reads the last 16 months again when the collected data
    // changes (#153); omitted rows per day mean the default on both sides.
    const refetch =
      nextConfig.siteUrl !== config.siteUrl ||
      nextConfig.dimensions !==
        toDimensionsValue(fromDimensionsValue(config.dimensions)) ||
      (nextConfig.rowLimit ?? DEFAULT_ROW_LIMIT) !==
        (typeof config.rowLimit === "number"
          ? config.rowLimit
          : DEFAULT_ROW_LIMIT);
    setPending(true);
    try {
      await updateConnection(workspaceId, connection.id, {
        ...(nextName !== "" && nextName !== connection.name
          ? { name: nextName }
          : {}),
        config: nextConfig,
      });
      if (mode === "finish") {
        router.replace(
          `/workspaces/${workspaceId}/connections/${connection.id}?setup=finished`,
        );
        return;
      }
      setNotice(
        refetch
          ? "Settings saved. The last 16 months are read again with the new settings."
          : "Settings saved.",
      );
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      {mode === "edit" ? (
        <div className="field">
          <label htmlFor="sc-name">Name</label>
          <input
            id="sc-name"
            type="text"
            required
            maxLength={100}
            value={name}
            disabled={pending}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
      ) : null}

      <fieldset className="choice-group" disabled={pending}>
        <legend>Property</legend>
        {properties.status === "loading" ? (
          <p className="muted">Loading the properties of this account…</p>
        ) : null}
        {properties.status === "error" ? (
          <div className="error" role="alert">
            {properties.reconnect
              ? "Google no longer accepts this connection's authorization. Reconnect Google above, then choose the property."
              : properties.message}
          </div>
        ) : null}
        {properties.status === "ready" && listed.length === 0 ? (
          <p className="muted">
            This Google account has no verified Search Console property. Ask an
            owner of the property to add the account in Search Console (Settings
            → Users and permissions), or reconnect with a different Google
            account.
          </p>
        ) : null}
        {listed.map((property) => (
          <label className="choice" key={property.siteUrl}>
            <input
              type="radio"
              name="sc-property"
              value={property.siteUrl}
              checked={siteUrl === property.siteUrl}
              onChange={() => setSiteUrl(property.siteUrl)}
            />
            <span>
              <span className="choice-title">{property.name}</span>
              <span className="muted">
                {" "}
                {property.kind}
                {property.permission ? ` · ${property.permission}` : ""}
              </span>
            </span>
          </label>
        ))}
        {unlisted ? (
          <label className="choice">
            <input
              type="radio"
              name="sc-property"
              value={siteUrl}
              checked
              readOnly
            />
            <span>
              <span className="choice-title">{siteUrl}</span>
              <span className="muted">
                {" "}
                No longer listed for this Google account
              </span>
            </span>
          </label>
        ) : null}
        <p className="help">
          Domain properties cover every protocol and subdomain; URL-prefix
          properties only the addresses under that prefix.
        </p>
      </fieldset>

      <fieldset className="choice-group" disabled={pending}>
        <legend>Breakdown (optional)</legend>
        <p className="help">
          Daily totals are always collected. Up to {MAX_BREAKDOWN_DIMENSIONS} of
          these add clicks and impressions per page, query, country or device.
        </p>
        <div className="choice-row">
          {SEARCH_CONSOLE_DIMENSIONS.map((dimension) => {
            const checked = dimensions.includes(dimension);
            return (
              <label className="checkbox" key={dimension}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={
                    !checked && dimensions.length >= MAX_BREAKDOWN_DIMENSIONS
                  }
                  onChange={() => toggleDimension(dimension)}
                />
                <span>{DIMENSION_LABELS[dimension]}</span>
              </label>
            );
          })}
        </div>
        {dimensions.length > 0 ? (
          <div className="field">
            <label htmlFor="sc-row-limit">Rows per day</label>
            <input
              id="sc-row-limit"
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_ROW_LIMIT}
              step={1}
              value={rowLimit}
              aria-describedby="sc-row-limit-help"
              onChange={(event) => setRowLimit(event.target.value)}
            />
            <p className="help" id="sc-row-limit-help">
              The top rows by clicks, at most{" "}
              {MAX_ROW_LIMIT.toLocaleString("en-US")}. Search Console leaves out
              rare queries to protect privacy, so a breakdown adds up to less
              than the totals.
            </p>
          </div>
        ) : null}
      </fieldset>

      {mode === "finish" ? (
        <p className="muted">
          Search Console data appears with a 2–3 day delay; the newest days are
          filled in once Google finalises them. The first sync reads the last 16
          months, as far back as Search Console keeps data.
        </p>
      ) : (
        <p className="muted">
          Changing the property, breakdown or rows per day reads the last 16
          months again with the new settings. Data collected with the earlier
          settings stays: a breakdown you remove keeps its past values but is no
          longer updated.
        </p>
      )}

      <div className="actions">
        <button
          type="submit"
          className="primary"
          disabled={pending || properties.status === "loading"}
        >
          {pending
            ? "Saving…"
            : mode === "finish"
              ? "Save and start syncing"
              : "Save changes"}
        </button>
      </div>
      {notice ? <div className="notice">{notice}</div> : null}
      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
    </form>
  );
}
