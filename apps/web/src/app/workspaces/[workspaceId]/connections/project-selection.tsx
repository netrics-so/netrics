"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import type {
  ConnectionDetail,
  ConnectorCatalogEntry,
  DiscoveredResource,
} from "@netrics/contracts";
import { useLeaveGuard } from "@/components/studio-editor/use-leave-guard";
import { AppPicker } from "./app-picker";
import {
  apiErrorMessage,
  previewStoredConnection,
  updateConnection,
} from "@/lib/api";
import { parseConfigSchema } from "@/lib/config-schema";
import { useLocale, useT } from "@/lib/i18n/client";

/** A project the connector could not sync: Web Analytics is not enabled. */
function withoutAnalytics(resource: DiscoveredResource): boolean {
  return resource.metadata?.webAnalytics === false;
}

/**
 * Which projects a website connection syncs, changed after connecting
 * (#782). The list comes from the provider with the stored token (the token
 * itself never reaches the browser); saving changes only the selection.
 * Deselected projects keep their collected data.
 */
export function ProjectSelection({
  workspaceId,
  connection,
  connector,
}: {
  workspaceId: string;
  connection: ConnectionDetail;
  connector: ConnectorCatalogEntry;
}) {
  const t = useT("connections.projects");
  const common = useT("common");
  const locale = useLocale();
  const router = useRouter();
  const fields = useMemo(
    () => parseConfigSchema(connector.configSchema),
    [connector],
  );
  const [resources, setResources] = useState<DiscoveredResource[] | null>(null);
  const [hidden, setHidden] = useState(0);
  const [selection, setSelection] = useState<string[] | null>(null);
  const [pending, setPending] = useState<"load" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  useLeaveGuard(dirty, t("unsaved"));

  async function load() {
    setPending("load");
    setError(null);
    setNotice(null);
    try {
      // The saved settings as they are: only the selection changes here.
      const result = await previewStoredConnection(workspaceId, connection.id, {
        config: Object.fromEntries(
          fields.flatMap((field) =>
            connection.config[field.key] === undefined
              ? []
              : [[field.key, connection.config[field.key]]],
          ),
        ),
      });
      if (!result.check.ok) {
        setError(result.check.message ?? t("accessFailed"));
        return;
      }
      setHidden(result.resources.filter(withoutAnalytics).length);
      setResources(
        result.resources.filter((resource) => !withoutAnalytics(resource)),
      );
      setSelection(result.selection);
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(null);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending("save");
    setError(null);
    setNotice(null);
    try {
      await updateConnection(workspaceId, connection.id, {
        resources: selection,
      });
      setDirty(false);
      setResources(null);
      setNotice(t("saved"));
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(null);
    }
  }

  return (
    <form className="stack" id="project-selection" onSubmit={save}>
      <h3>{t("heading")}</h3>
      <p className="muted">{t("intro")}</p>
      {resources === null ? (
        <>
          <div className="actions">
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => void load()}
            >
              {pending === "load" ? t("checking") : t("check")}
            </button>
          </div>
        </>
      ) : (
        <>
          <AppPicker
            texts="connections.projects"
            resources={resources}
            value={selection}
            onChange={(value) => {
              setDirty(true);
              setSelection(value);
            }}
            disabled={pending !== null}
          />
          {hidden > 0 ? (
            <p className="help">{t("withoutAnalytics", { count: hidden })}</p>
          ) : null}
          <div className="actions">
            <button
              className="primary"
              type="submit"
              disabled={pending !== null || !dirty}
            >
              {pending === "save" ? common("saving") : t("save")}
            </button>
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => {
                setResources(null);
                setDirty(false);
                setError(null);
              }}
            >
              {t("cancel")}
            </button>
          </div>
        </>
      )}
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
