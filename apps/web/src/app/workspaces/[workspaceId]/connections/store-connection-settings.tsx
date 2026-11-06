"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import type {
  ConnectionDetail,
  ConnectorCatalogEntry,
  StoredConnectionPreviewResponse,
} from "@netrics/contracts";
import { useLeaveGuard } from "@/components/studio-editor/use-leave-guard";
import { AppPicker } from "./app-picker";
import { ConfigFields } from "./config-fields";
import {
  apiErrorMessage,
  previewStoredConnection,
  updateConnection,
} from "@/lib/api";
import {
  coerceConfigValues,
  initialConfigValues,
  parseConfigSchema,
} from "@/lib/config-schema";
import { useLocale, useT } from "@/lib/i18n/client";

/** Check access and choose the app scope before a single atomic settings save. */
export function StoreConnectionSettings({
  workspaceId,
  connection,
  connector,
}: {
  workspaceId: string;
  connection: ConnectionDetail;
  connector: ConnectorCatalogEntry;
}) {
  const t = useT("connections.apps");
  const common = useT("common");
  const locale = useLocale();
  const router = useRouter();
  const fields = useMemo(
    () => parseConfigSchema(connector.configSchema),
    [connector],
  );
  const google = connection.connectorId === "google-play";
  const primaryKeys = google
    ? ["reportBucket", "ratingStorefront"]
    : ["vendorNumber", "ratingStorefront"];
  const [values, setValues] = useState(() =>
    initialConfigValues(fields, connection.config),
  );
  const [name, setName] = useState(connection.name);
  const [preview, setPreview] =
    useState<StoredConnectionPreviewResponse | null>(null);
  const [selection, setSelection] = useState<string[] | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [pending, setPending] = useState<"check" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  useLeaveGuard(dirty, t("unsaved"));
  const [notice, setNotice] = useState<string | null>(null);
  function change(key: string, value: string) {
    setDirty(true);
    setValues((current) => ({ ...current, [key]: value }));
    setPreview(null);
    setNotice(null);
  }
  async function check() {
    setPending("check");
    setError(null);
    setNotice(null);
    setPreview(null);
    try {
      const result = await previewStoredConnection(workspaceId, connection.id, {
        config: coerceConfigValues(fields, values),
      });
      setPreview(result);
      if (!initialized) {
        setSelection(result.selection);
        setInitialized(true);
      }
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(null);
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preview?.check.ok) return;
    setPending("save");
    setError(null);
    setNotice(null);
    try {
      await updateConnection(workspaceId, connection.id, {
        name: name.trim(),
        config: coerceConfigValues(fields, values),
        resources: selection,
      });
      setDirty(false);
      setNotice(t("saved"));
      if (connection.setupPending)
        router.replace(
          `/workspaces/${workspaceId}/connections/${connection.id}?setup=finished`,
        );
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(null);
    }
  }
  return (
    <form className="stack" onSubmit={save}>
      <p className="muted">{t("intro")}</p>
      <div className="field">
        <label htmlFor="store-connection-name">{t("name")}</label>
        <input
          id="store-connection-name"
          required
          maxLength={100}
          value={name}
          disabled={pending !== null}
          onChange={(event) => {
            setName(event.target.value);
            setDirty(true);
          }}
        />
      </div>
      <ConfigFields
        fields={fields.filter((field) => primaryKeys.includes(field.key))}
        values={values}
        disabled={pending !== null}
        onChange={change}
      />
      {google ? (
        <p className="help">
          <a
            href="https://support.google.com/googleplay/android-developer/answer/6135870?hl=en"
            target="_blank"
            rel="noreferrer"
          >
            {t("reportGuide")}
          </a>
        </p>
      ) : null}
      <details>
        <summary>{t("advanced")}</summary>
        <div className="stack">
          <ConfigFields
            fields={fields.filter((field) => !primaryKeys.includes(field.key))}
            values={values}
            disabled={pending !== null}
            onChange={change}
          />
        </div>
      </details>
      <p className="help">{t("scopeHelp")}</p>
      <div className="actions">
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void check()}
        >
          {pending === "check" ? t("checking") : t("check")}
        </button>
      </div>
      {preview ? (
        <div
          className={preview.check.ok ? "notice" : "error"}
          role={preview.check.ok ? "status" : "alert"}
        >
          {preview.check.message ??
            (preview.check.ok ? t("accessOk") : t("accessFailed"))}
        </div>
      ) : null}
      {preview?.check.ok ? (
        <AppPicker
          resources={preview.resources}
          value={selection}
          onChange={(value) => {
            setDirty(true);
            setSelection(value);
            setNotice(null);
          }}
          disabled={pending !== null}
        />
      ) : null}
      <div className="actions">
        <button
          className="primary"
          type="submit"
          disabled={pending !== null || !preview?.check.ok}
        >
          {pending === "save"
            ? common("saving")
            : connection.setupPending
              ? t("start")
              : t("save")}
        </button>
      </div>
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
