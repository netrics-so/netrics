"use client";

import { useRouter } from "next/navigation";
import { useId, useMemo, useState, type FormEvent } from "react";
import type {
  ConnectionDetail,
  ConnectorCatalogEntry,
  DiscoveredResource,
  SelectedResource,
  StoredConnectionPreviewResponse,
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
 * What the picker shows for a loaded project list. A refused check (no
 * project with Web Analytics is left, say) still opens the picker with the
 * refusal and what can be done about it: the stored selection can be
 * reduced, to at least one project (#854). Projects without Web Analytics
 * are not offered; a selected one stays in the selection, as not listed, so
 * it can be removed.
 */
export function pickerState(result: StoredConnectionPreviewResponse): {
  resources: DiscoveredResource[];
  hidden: number;
  selection: string[] | null;
  refusal: string | null;
} {
  return {
    resources: result.resources.filter(
      (resource) => !withoutAnalytics(resource),
    ),
    hidden: result.resources.filter(withoutAnalytics).length,
    selection: result.selection,
    refusal: result.check.ok ? null : (result.check.message ?? ""),
  };
}

/** Most synced projects named before "and N more". */
const SYNCED_SHOWN = 20;

/**
 * Whether a selection can be saved (#854): all projects (null) or at least
 * one. The API refuses an empty one for this connector too.
 */
export function selectionSavable(selection: readonly string[] | null) {
  return selection === null || selection.length > 0;
}

/**
 * What the connection is set to sync, shown without loading the project
 * list (#854): the stored selection as the connection's page got it, by
 * name where one is known and by ID otherwise. It is the configuration, not
 * what the provider serves right now: the page makes no provider call, so
 * a project the token lost or without Web Analytics is only marked once
 * the list is loaded, and the text says so. A connection that still stores
 * an empty selection (from before one was required) collects nothing and
 * says how to change that. Nothing while the selection is unknown.
 */
export function SyncedProjects({
  selection,
}: {
  selection: readonly SelectedResource[] | null | undefined;
}) {
  const t = useT("connections.projects");
  if (selection === undefined) return null;
  if (selection === null) return <p>{t("syncedAll")}</p>;
  if (selection.length === 0)
    return (
      <p className="notice warning" role="status">
        {t("syncedNone", { action: t("check") })}
      </p>
    );
  const shown = selection.slice(0, SYNCED_SHOWN);
  return (
    <>
      <p>{t("syncedList", { count: selection.length })}</p>
      <ul>
        {shown.map((resource) => (
          <li key={resource.id}>{resource.name ?? resource.id}</li>
        ))}
        {selection.length > shown.length ? (
          <li className="muted">
            {t("syncedMore", { count: selection.length - shown.length })}
          </li>
        ) : null}
      </ul>
      <p className="help">{t("syncedHelp", { action: t("check") })}</p>
    </>
  );
}

/**
 * The loaded project list with the selection being edited: the check's
 * refusal with what can be done, the picker, and Save, which needs a
 * change and a selection that names a project (or all of them).
 */
export function ProjectSelectionEditor({
  resources,
  hidden,
  refusal,
  selection,
  dirty,
  pending,
  onChange,
  onCancel,
}: {
  resources: DiscoveredResource[];
  hidden: number;
  refusal: string | null;
  selection: string[] | null;
  dirty: boolean;
  pending: "load" | "save" | null;
  onChange: (selection: string[] | null) => void;
  onCancel: () => void;
}) {
  const t = useT("connections.projects");
  const common = useT("common");
  const hintId = useId();
  const savable = selectionSavable(selection);
  return (
    <>
      {refusal !== null ? (
        <div className="error" role="alert">
          <p>{refusal}</p>
          <p>{t("refusedHelp")}</p>
        </div>
      ) : null}
      <AppPicker
        texts="connections.projects"
        resources={resources}
        value={selection}
        onChange={onChange}
        disabled={pending !== null}
        noneHelpId={hintId}
      />
      {hidden > 0 ? (
        <p className="help">{t("withoutAnalytics", { count: hidden })}</p>
      ) : null}
      <div className="actions">
        <button
          className="primary"
          type="submit"
          disabled={pending !== null || !dirty || !savable}
          aria-describedby={savable ? undefined : hintId}
        >
          {pending === "save" ? common("saving") : t("save")}
        </button>
        <button type="button" disabled={pending !== null} onClick={onCancel}>
          {t("cancel")}
        </button>
      </div>
    </>
  );
}

/**
 * Which projects a website connection syncs, shown up front (#854) and
 * changed after connecting (#782). The list to choose from comes from the
 * provider with the stored token (the token itself never reaches the
 * browser); saving changes only the selection. Deselected projects keep
 * their collected data.
 */
export function ProjectSelection({
  workspaceId,
  connection,
  connector,
  synced,
}: {
  workspaceId: string;
  connection: ConnectionDetail;
  connector: ConnectorCatalogEntry;
  /** The stored selection, from the connection's detail response. */
  synced?: readonly SelectedResource[] | null;
}) {
  const t = useT("connections.projects");
  const locale = useLocale();
  const router = useRouter();
  const fields = useMemo(
    () => parseConfigSchema(connector.configSchema),
    [connector],
  );
  const [resources, setResources] = useState<DiscoveredResource[] | null>(null);
  const [hidden, setHidden] = useState(0);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [selection, setSelection] = useState<string[] | null>(null);
  const [pending, setPending] = useState<"load" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const leaveDialog = useLeaveGuard(dirty, t("unsaved"));

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
      const state = pickerState(result);
      setHidden(state.hidden);
      setResources(state.resources);
      setSelection(state.selection);
      setRefusal(
        state.refusal === null ? null : state.refusal || t("accessFailed"),
      );
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(null);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectionSavable(selection)) return;
    setPending("save");
    setError(null);
    setNotice(null);
    try {
      await updateConnection(workspaceId, connection.id, {
        resources: selection,
      });
      setDirty(false);
      setResources(null);
      setRefusal(null);
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
          <SyncedProjects selection={synced} />
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
        <ProjectSelectionEditor
          resources={resources}
          hidden={hidden}
          refusal={refusal}
          selection={selection}
          dirty={dirty}
          pending={pending}
          onChange={(value) => {
            setDirty(true);
            setSelection(value);
          }}
          onCancel={() => {
            setResources(null);
            setRefusal(null);
            setDirty(false);
            setError(null);
          }}
        />
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
      {leaveDialog}
    </form>
  );
}
