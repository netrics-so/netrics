"use client";

import { useRouter } from "next/navigation";
import { useId, useMemo, useRef, useState, type FormEvent } from "react";
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
import { useFocusKeeper } from "@/lib/focus-handoff";
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

/** Most selected projects named before "and N more". */
export const SYNCED_SHOWN = 20;
/**
 * Most projects one "show more" adds: a stored selection has no length
 * limit, and tens of thousands of list items at once would stall the page.
 */
export const SYNCED_STEP = 500;

/**
 * The part of a stored selection the list shows with `limit` entries, and
 * what its buttons offer: how many the next step adds (all that is left,
 * at most SYNCED_STEP), and whether the list can be made short again.
 */
export function syncedPage<T>(
  selection: readonly T[],
  limit: number,
): { shown: readonly T[]; rest: number; next: number; expanded: boolean } {
  const shown = selection.slice(0, Math.max(limit, SYNCED_SHOWN));
  const rest = selection.length - shown.length;
  return {
    shown,
    rest,
    next: Math.min(rest, SYNCED_STEP),
    expanded: shown.length > SYNCED_SHOWN,
  };
}

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
 *
 * `canChange` is false for someone who may read the connection but not
 * change it (a viewer): the same facts, without pointing at a button they
 * do not have. A list longer than SYNCED_SHOWN is cut short and opens in
 * place, from the stored names and without a provider call, so it also
 * works when the token has expired; `initialLimit` is for tests.
 * `canDelete` is false for someone who may change the selection but not
 * delete the connection (an editor): deleting is then something to ask an
 * owner or admin for, not a button to look for.
 */
export function SyncedProjects({
  selection,
  canChange = true,
  canDelete = true,
  initialLimit = SYNCED_SHOWN,
}: {
  selection: readonly SelectedResource[] | null | undefined;
  canChange?: boolean;
  canDelete?: boolean;
  initialLimit?: number;
}) {
  const t = useT("connections.projects");
  const listId = useId();
  const [limit, setLimit] = useState(initialLimit);
  if (selection === undefined) return null;
  if (selection === null) return <p>{t("syncedAll")}</p>;
  if (selection.length === 0)
    return (
      <p className="notice warning" role="status">
        {!canChange
          ? t("syncedNoneViewer")
          : t(canDelete ? "syncedNone" : "syncedNoneNoDelete", {
              action: t("check"),
            })}
      </p>
    );
  const { shown, rest, next, expanded } = syncedPage(selection, limit);
  return (
    <>
      <p>{t("syncedList", { count: selection.length })}</p>
      <ul id={listId}>
        {shown.map((resource) => (
          <li key={resource.id}>{resource.name ?? resource.id}</li>
        ))}
        {rest > 0 ? (
          <li className="muted">{t("syncedMore", { count: rest })}</li>
        ) : null}
      </ul>
      {selection.length > SYNCED_SHOWN ? (
        // The list's buttons can go while one has the keyboard focus (the
        // extra "Show fewer"; both when a shorter saved selection arrives):
        // whoever renders this list keeps the focus (`syncedFocusZone`).
        <div className="actions" data-synced-actions>
          {/* One button for the whole list, mounted throughout: it shows
              more while there is more and closes the list once all of it
              is shown, so the keyboard focus that opened the list is still
              on the control that closes it. */}
          <button
            data-synced-toggle
            type="button"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() =>
              setLimit(rest > 0 ? shown.length + next : SYNCED_SHOWN)
            }
          >
            {rest === 0
              ? t("syncedShowFewer")
              : next === rest
                ? t("syncedShowAll", { count: selection.length })
                : t("syncedShowMore", { count: next })}
          </button>
          {/* Part of a very long list is open: closing it needs no walk
              to its end. This button goes with the click; the focus it
              had moves to the one that stays. */}
          {expanded && rest > 0 ? (
            <button
              type="button"
              aria-controls={listId}
              onClick={() => setLimit(SYNCED_SHOWN)}
            >
              {t("syncedShowFewer")}
            </button>
          ) : null}
        </div>
      ) : null}
      <p className="help">
        {canChange
          ? t("syncedHelp", { action: t("check") })
          : t("syncedHelpViewer")}
      </p>
    </>
  );
}

/** Whether a focused element is one of the list's buttons. */
function inSyncedActions(element: Element): boolean {
  return element.closest("[data-synced-actions]") !== null;
}
/** The list's toggle, where the focus of a button that went goes. */
function syncedToggle(region: Element | null): HTMLElement | null {
  return region?.querySelector<HTMLElement>("[data-synced-toggle]") ?? null;
}

/**
 * The selection for someone who may read the connection but not change it
 * (#854): the panel's heading and what is selected, without the form.
 */
export function SyncedProjectsReadOnly({
  selection,
}: {
  selection: readonly SelectedResource[] | null | undefined;
}) {
  const t = useT("connections.projects");
  const card = useRef<HTMLDivElement>(null);
  useFocusKeeper(card, () => syncedToggle(card.current));
  if (selection === undefined) return null;
  return (
    <div className="card stack" id="project-selection" ref={card}>
      <h2>{t("heading")}</h2>
      <SyncedProjects selection={selection} canChange={false} />
    </div>
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
  canDelete = true,
  onChange,
  onCancel,
}: {
  /** Whether the user may delete the connection (see SyncedProjects). */
  canDelete?: boolean;
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
          <p>{t(canDelete ? "refusedHelp" : "refusedHelpNoDelete")}</p>
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
          disabled={!dirty || !savable}
          // Not disabled while saving (the form ignores a second submit):
          // a disabled button drops the keyboard focus, which is handed
          // back to "Change project selection" when the picker closes.
          aria-disabled={pending !== null}
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
  canDelete = true,
}: {
  /** Whether the user may delete the connection (`connections:delete`). */
  canDelete?: boolean;
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
  // Updates of the panel remove or disable what may have the keyboard
  // focus: the list of selected projects with its buttons and "Change
  // project selection" when the picker opens; the picker when it closes
  // (cancelled or saved); the picker's fields while saving; the list's
  // buttons when a shorter saved selection arrives. The form keeps its
  // focus (`useFocusKeeper`), and where it goes depends on where it was
  // and on what the form shows afterwards.
  const form = useRef<HTMLFormElement>(null);
  const change = useRef<HTMLButtonElement>(null);
  useFocusKeeper<"picker" | "list" | "panel">(
    form,
    (zone) => {
      const picker = form.current?.querySelector<HTMLFieldSetElement>(
        "fieldset.app-picker",
      );
      // The picker is closed: a button of the list that went hands on to
      // the list's toggle if there still is one; everything else, and the
      // closed picker, to the button that opens it.
      if (!picker)
        return (
          (zone === "list" ? syncedToggle(form.current) : null) ??
          change.current
        );
      // Saving: the fields are disabled, Save stays focusable.
      if (picker.disabled)
        return form.current?.querySelector<HTMLElement>(
          'button[type="submit"]',
        );
      // A change inside the open picker is the picker's own to keep.
      if (zone === "picker") return null;
      // The picker has just opened: onto the chosen mode ("all projects"
      // first, "choose" second).
      return picker.querySelectorAll<HTMLElement>('input[type="radio"]')[
        selection === null ? 0 : 1
      ];
    },
    (element) =>
      element.closest("fieldset.app-picker")
        ? "picker"
        : inSyncedActions(element)
          ? "list"
          : "panel",
  );

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
    if (pending !== null || !selectionSavable(selection)) return;
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
    <form className="stack" id="project-selection" ref={form} onSubmit={save}>
      <h3>{t("heading")}</h3>
      <p className="muted">{t("intro")}</p>
      {resources === null ? (
        <>
          <SyncedProjects selection={synced} canDelete={canDelete} />
          <div className="actions">
            <button
              ref={change}
              type="button"
              // Not disabled while loading: a disabled button drops the
              // keyboard focus before the picker can take it.
              aria-disabled={pending !== null}
              onClick={() => {
                if (pending === null) void load();
              }}
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
          canDelete={canDelete}
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
