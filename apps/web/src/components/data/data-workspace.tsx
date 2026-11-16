"use client";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { DataUsers } from "@netrics/contracts";
import {
  deleteDataItem,
  getDataSources,
  previewData,
  setDataProject,
  readReference,
  type ReferenceTable,
  type DataWorkspace as WorkspaceData,
  type DataPreview,
  type PreparationDraft,
  type ModelDraft,
  type DataSource,
} from "@/lib/data-api";
import { loadDataLists } from "@/lib/data-lists";
import {
  editorSources,
  missingSources,
  referencedSourceIds,
} from "@/lib/project-pickers";
import { activeProjectName, projectScope } from "@/lib/project-scope";
import { ProjectSelect } from "@/components/project-select";
import { dataErrorKey, newDataId } from "@/lib/data-editing";
import { ApiError } from "@/lib/api";
import { useConfirmation } from "@/components/confirm-dialog";
import { useT, useLocale } from "@/lib/i18n/client";
import { useLeaveGuard } from "@/components/studio-editor/use-leave-guard";
import { DataTable } from "./data-table";
import { PreparationEditor } from "./preparation-editor";
import { ModelEditor } from "./model-editor";
import { ReferenceEditor } from "./reference-editor";
import { PreviewNotes } from "./preview-notes";
import { StoreUpdateSummary } from "@/components/store-update-summary";
import { dataUpdates, storeUpdatePath } from "@/lib/store-updates";

type Section = "datasets" | "preparations" | "models";
type ProjectRef = { id: string; name: string; archivedAt: string | null };
const NO_PROJECTS: ProjectRef[] = [];
/** The saved item an editor shows, for its project select (#573). */
type EditorRecord = { key: string; id: string; projectId: string | null };
type Editor = { key: string } & (
  | { kind: "preparation"; initial: PreparationDraft | null; sourceId?: string }
  | { kind: "model"; initial: ModelDraft | null }
  | { kind: "reference"; initial?: ReferenceTable }
);
export function DataWorkspace({
  workspaceId,
  initial,
  initialPickerSources,
  projects = NO_PROJECTS,
  activeProjectId = null,
  openModelId,
  openModel,
  openPreparationId,
  initialSection,
  canDelete = false,
}: {
  workspaceId: string;
  initial: WorkspaceData;
  /** Sources the editors offer; without it, the listed datasets. */
  initialPickerSources?: DataSource[];
  /** The workspace's projects, archived ones included (#573). */
  projects?: ProjectRef[];
  /** The user's active project: lists follow it; null is "All". */
  activeProjectId?: string | null;
  /** A model to open first (the Studio links here to publish one). */
  openModelId?: string;
  /** That model when the navigation list leaves it out (#573). */
  openModel?: ModelDraft;
  /** A preparation to open first (a store-template update links here). */
  openPreparationId?: string;
  /** The tab shown first when no editor opens. */
  initialSection?: Section;
  /** Whether the caller may delete preparations and models (#671). */
  canDelete?: boolean;
}) {
  const t = useT("data"),
    dashboardsT = useT("dashboardsPage"),
    updateT = useT("storeUpdate"),
    locale = useLocale(),
    searchId = useId(),
    sourceSelectId = useId();
  const scope = useMemo(
    () => projectScope(activeProjectId, projects),
    [activeProjectId, projects],
  );
  const projectName = activeProjectName(scope, projects);
  // A model of another project opens too, without joining the list.
  const linkedModel = openModelId
    ? (initial.models.find((model) => model.id === openModelId) ??
      (openModel?.id === openModelId ? openModel : undefined))
    : undefined;
  const linkedPreparation =
    !linkedModel && openPreparationId
      ? initial.preparations.find((p) => p.id === openPreparationId)
      : undefined;
  const [pickerSources, setPickerSources] = useState(
    initialPickerSources ?? initial.sources,
  );
  const [data, setData] = useState(initial),
    [section, setSection] = useState<Section>(
      linkedModel
        ? "models"
        : linkedPreparation
          ? "preparations"
          : (initialSection ?? "datasets"),
    );
  const [editor, setEditor] = useState<Editor | null>(() =>
      linkedModel
        ? { kind: "model", initial: linkedModel, key: newDataId() }
        : linkedPreparation
          ? {
              kind: "preparation",
              initial: linkedPreparation,
              key: newDataId(),
            }
          : null,
    ),
    [dirty, setDirty] = useState(false);
  // A new active project (#641), however it changed (the sidebar, another
  // tab, an archive by someone else): the lists follow the refreshed server
  // data, while an open editor keeps its draft.
  const [listedProject, setListedProject] = useState(activeProjectId);
  if (listedProject !== activeProjectId) {
    setListedProject(activeProjectId);
    setData(initial);
    setPickerSources(initialPickerSources ?? initial.sources);
  }
  // The item open in an editor, once saved: its project select (#573).
  const [saved, setSaved] = useState<EditorRecord | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [movingProject, setMovingProject] = useState(false);
  // Sources the open item reads that the picker scope leaves out (another
  // or an archived project): kept so the editor still knows them.
  const [allSources, setAllSources] = useState<DataSource[] | null>(null);
  const referenced = useMemo(
    () =>
      referencedSourceIds(
        editor?.kind === "preparation"
          ? editor.initial?.graph
          : editor?.kind === "model"
            ? editor.initial?.definition
            : null,
      ),
    [editor],
  );
  const needsAll = missingSources(pickerSources, referenced);
  useEffect(() => {
    if (!needsAll || allSources) return;
    let alive = true;
    getDataSources(workspaceId)
      .then((sources) => {
        if (alive) setAllSources(sources);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [needsAll, allSources, workspaceId]);
  const editorSourceList = useMemo(
    () => editorSources(pickerSources, allSources, referenced),
    [pickerSources, allSources, referenced],
  );
  const editorRecord: EditorRecord | null =
    editor && saved?.key === editor.key
      ? saved
      : editor &&
          (editor.kind === "preparation" || editor.kind === "model") &&
          editor.initial
        ? {
            key: editor.key,
            id: editor.initial.id,
            projectId: editor.initial.projectId,
          }
        : null;
  async function moveToProject(projectId: string | null) {
    if (!editor || !editorRecord) return;
    if (editor.kind !== "preparation" && editor.kind !== "model") return;
    setMovingProject(true);
    setProjectError(null);
    try {
      const moved = await setDataProject(
        workspaceId,
        editor.kind === "preparation" ? "preparations" : "models",
        editorRecord.id,
        projectId,
      );
      setSaved({ ...editorRecord, projectId: moved.projectId });
      // The lists follow the active project: the item joins or leaves them.
      void refresh();
    } catch (failure) {
      setProjectError(t(`errors.${dataErrorKey(failure)}`));
    } finally {
      setMovingProject(false);
    }
  }
  const [selected, setSelected] = useState(initial.sources[0]?.id ?? ""),
    [search, setSearch] = useState("");
  const [preview, setPreview] = useState<DataPreview | null>(null),
    [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  // Deleting a preparation or model (#671): the app's own confirmation,
  // then what still uses it when the server refuses.
  const confirmation = useConfirmation();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteResult, setDeleteResult] = useState<
    | { kind: "deleted" | "alreadyDeleted"; name: string }
    | { kind: "inUse"; name: string; usedBy: DataUsers }
    | { kind: "failed"; message: string }
    | null
  >(null);
  async function deleteItem(
    kind: "preparation" | "model",
    id: string,
    name: string,
  ) {
    const confirmed = await confirmation.ask({
      title: t(
        kind === "preparation"
          ? "delete.preparationTitle"
          : "delete.modelTitle",
        { name },
      ),
      text: t("delete.text"),
      confirm: t("delete.confirm"),
      cancel: t("delete.cancel"),
    });
    if (!confirmed) return;
    setDeleting(id);
    setDeleteResult(null);
    const gone = (result: {
      kind: "deleted" | "alreadyDeleted";
      name: string;
    }) => {
      setData((value) => ({
        ...value,
        preparations: value.preparations.filter((p) => p.id !== id),
        models: value.models.filter((m) => m.id !== id),
      }));
      if (editorRecord?.id === id) {
        setDirty(false);
        setEditor(null);
      }
      setDeleteResult(result);
      void refresh();
    };
    try {
      await deleteDataItem(
        workspaceId,
        kind === "preparation" ? "preparations" : "models",
        id,
      );
      gone({ kind: "deleted", name });
    } catch (failure) {
      const outcome = deleteFailure(failure);
      if (outcome.kind === "gone")
        // Deleted already (another tab, another member): gone all the same.
        gone({ kind: "alreadyDeleted", name });
      else
        setDeleteResult(
          outcome.kind === "inUse"
            ? { kind: "inUse", name, usedBy: outcome.usedBy }
            : {
                kind: "failed",
                message:
                  outcome.kind === "forbidden" || outcome.kind === "busy"
                    ? t(`delete.${outcome.kind}`)
                    : t(`errors.${dataErrorKey(failure)}`),
              },
        );
    } finally {
      setDeleting(null);
    }
  }
  const deleteButton = (
    kind: "preparation" | "model",
    id: string,
    name: string,
  ) =>
    canDelete ? (
      <button
        type="button"
        className="danger"
        aria-label={t("delete.actionNamed", { name })}
        disabled={deleting !== null}
        onClick={() => void deleteItem(kind, id, name)}
      >
        {deleting === id ? t("delete.deleting") : t("delete.action")}
      </button>
    ) : null;
  useLeaveGuard(dirty, t("unsaved"));
  const referenceAbort = useRef<AbortController | null>(null);
  const [referenceLoading, setReferenceLoading] = useState<{
    loaded: number;
    total: number;
  } | null>(null);
  useEffect(
    () => () => referenceAbort.current?.abort(),
    [selected, editor?.key, section],
  );
  async function editReference() {
    referenceAbort.current?.abort();
    const controller = new AbortController();
    referenceAbort.current = controller;
    setReferenceLoading({ loaded: 0, total: 0 });
    setError(null);
    try {
      const reference = await readReference(
        workspaceId,
        selected,
        (loaded, total) => setReferenceLoading({ loaded, total }),
        controller.signal,
      );
      if (!controller.signal.aborted)
        open({ kind: "reference", initial: reference });
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(t(`errors.${dataErrorKey(cause)}`));
    } finally {
      if (referenceAbort.current === controller) setReferenceLoading(null);
    }
  }
  const selectedSource = data.sources.find((source) => source.id === selected);
  useEffect(() => {
    let alive = true;
    if (!selected || editor) return;
    setLoading(true);
    setError(null);
    setPreview(null);
    previewData(workspaceId, selected)
      .then((value) => {
        if (alive) setPreview(value);
      })
      .catch((failure: unknown) => {
        if (alive) setError(t(`errors.${dataErrorKey(failure)}`));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [workspaceId, selected, editor, t, previewRevision]);
  function leave(next: () => void) {
    if (!dirty || window.confirm(t("unsaved"))) {
      setDirty(false);
      setError(null);
      setDeleteResult(null);
      next();
    }
  }
  function open(value: Omit<Editor, "key"> | Editor) {
    leave(() => setEditor({ ...value, key: newDataId() } as Editor));
  }
  async function refresh() {
    try {
      const { data: next, pickerSources: sources } = await loadDataLists(
        workspaceId,
        scope,
      );
      setData(next);
      setPickerSources(sources);
      if (!selected && next.sources[0]) setSelected(next.sources[0].id);
    } catch (failure) {
      setError(t(`errors.${dataErrorKey(failure)}`));
    }
  }
  function preparationSaved(draft: PreparationDraft) {
    if (editor)
      setSaved({ key: editor.key, id: draft.id, projectId: draft.projectId });
    setData((value) => ({
      ...value,
      preparations: [
        ...value.preparations.filter((p) => p.id !== draft.id),
        draft,
      ],
    }));
    if (draft.publishedVersion) void refresh();
  }
  function modelSaved(model: ModelDraft) {
    if (editor)
      setSaved({ key: editor.key, id: model.id, projectId: model.projectId });
    setData((value) => ({
      ...value,
      models: [...value.models.filter((m) => m.id !== model.id), model],
    }));
  }
  // A store-template update (11E): offered, or waiting on its drafts.
  const updates = dataUpdates(data.storeUpdates ?? initial.storeUpdates ?? []);
  const updateMark = (id: string) => {
    const install = updates.marked.get(id);
    return install ? (
      <Link
        className="data-update-mark"
        href={storeUpdatePath(workspaceId, install.requestId)}
        title={updateT("dataBanner", { name: install.name })}
      >
        {updateT("dataMark")}
      </Link>
    ) : null;
  };
  const counts = {
    datasets: data.sources.length,
    preparations: data.preparations.length,
    models: data.models.length,
  };
  const close = () =>
    leave(() => {
      setEditor(null);
      void refresh();
    });
  return (
    <div className="area-page data-page">
      <header className="page-header">
        <div>
          <h1>{t("title")}</h1>
          <p className="page-meta">
            {projectName
              ? `${t("subtitle")} · ${dashboardsT("activeProjectMeta", { project: projectName })}`
              : t("subtitle")}
          </p>
        </div>
        {!editor ? (
          <div className="page-actions">
            {section === "datasets" ? (
              <button type="button" onClick={() => open({ kind: "reference" })}>
                {t("newReference")}
              </button>
            ) : section === "preparations" ? (
              <button
                type="button"
                className="primary"
                onClick={() => open({ kind: "preparation", initial: null })}
              >
                {t("newPreparation")}
              </button>
            ) : (
              <button
                type="button"
                className="primary"
                onClick={() => open({ kind: "model", initial: null })}
              >
                {t("newModel")}
              </button>
            )}
          </div>
        ) : null}
      </header>
      {updates.offered.map((install) => {
        const waiting = install.openUpdate?.drafts.filter(
          (draft) => !draft.published,
        ).length;
        return (
          <section
            key={install.requestId}
            className="notice warning data-update-banner"
            aria-label={updateT("dataBanner", { name: install.name })}
          >
            <strong>{updateT("dataBanner", { name: install.name })}</strong>{" "}
            {install.openUpdate ? (
              waiting ? (
                <span>{updateT("dataProgress", { count: waiting })}</span>
              ) : null
            ) : install.summary ? (
              <StoreUpdateSummary summary={install.summary} />
            ) : null}{" "}
            <Link href={storeUpdatePath(workspaceId, install.requestId)}>
              {updateT(install.openUpdate ? "openUpdate" : "review")}
            </Link>
          </section>
        );
      })}
      {confirmation.dialog}
      {deleteResult?.kind === "deleted" ||
      deleteResult?.kind === "alreadyDeleted" ? (
        <p className="notice" role="status">
          {t(`delete.${deleteResult.kind}`, { name: deleteResult.name })}
        </p>
      ) : deleteResult?.kind === "failed" ? (
        <p className="error" role="alert">
          {deleteResult.message}
        </p>
      ) : deleteResult?.kind === "inUse" ? (
        <DataInUseNotice
          workspaceId={workspaceId}
          name={deleteResult.name}
          usedBy={deleteResult.usedBy}
        />
      ) : null}
      <nav className="data-tabs" aria-label={t("title")}>
        {(["datasets", "preparations", "models"] as const).map((key) => (
          <button
            type="button"
            key={key}
            aria-current={section === key ? "page" : undefined}
            onClick={() =>
              leave(() => {
                setSection(key);
                setEditor(null);
              })
            }
          >
            {t(key)}
            <span>{new Intl.NumberFormat(locale).format(counts[key])}</span>
          </button>
        ))}
      </nav>
      {error && editor ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {editorRecord &&
      (projects.length > 0 || editorRecord.projectId || canDelete) ? (
        <div className="data-editor-project">
          {projects.length > 0 || editorRecord.projectId ? (
            <ProjectSelect
              projects={projects}
              value={editorRecord.projectId}
              disabled={movingProject}
              onChange={(projectId) => void moveToProject(projectId)}
            />
          ) : null}
          {editor?.kind === "preparation" || editor?.kind === "model"
            ? deleteButton(
                editor.kind,
                editorRecord.id,
                (editor.kind === "preparation"
                  ? data.preparations.find((p) => p.id === editorRecord.id)
                      ?.name
                  : data.models.find((m) => m.id === editorRecord.id)?.name) ??
                  editor.initial?.name ??
                  "",
              )
            : null}
          {projectError ? (
            <p className="error" role="alert">
              {projectError}
            </p>
          ) : null}
        </div>
      ) : null}
      {editor?.kind === "preparation" ? (
        <PreparationEditor
          key={editor.key}
          workspaceId={workspaceId}
          sources={editorSourceList}
          projectId={scope.active}
          initial={editor.initial}
          sourceId={editor.sourceId}
          onSaved={preparationSaved}
          onClose={close}
          onDirty={setDirty}
        />
      ) : editor?.kind === "model" ? (
        <ModelEditor
          key={editor.key}
          workspaceId={workspaceId}
          sources={editorSourceList}
          projectId={scope.active}
          initial={editor.initial}
          onSaved={modelSaved}
          onClose={close}
          onDirty={setDirty}
        />
      ) : editor?.kind === "reference" ? (
        <ReferenceEditor
          initial={editor.initial}
          key={editor.key}
          workspaceId={workspaceId}
          onDirty={setDirty}
          onClose={close}
          onSaved={() => {
            setDirty(false);
            setEditor(null);
            setSection("datasets");
            void refresh();
          }}
        />
      ) : section === "datasets" ? (
        <>
          {!data.sources.length ? (
            <div className="data-empty">
              <h2>{t("emptyDatasets")}</h2>
              <p>{t("emptyDatasetsHint")}</p>
              <Link
                href={`/workspaces/${workspaceId}/connections/new`}
                className="button primary"
              >
                {t("connectSource")}
              </Link>
            </div>
          ) : (
            <div className="data-dataset-layout">
              <aside className="data-source-list">
                <div className="field data-mobile-source">
                  <label htmlFor={sourceSelectId}>{t("sourceName")}</label>
                  <select
                    id={sourceSelectId}
                    value={selected}
                    onChange={(e) => setSelected(e.target.value)}
                  >
                    {data.sources.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field data-source-search">
                  <label htmlFor={searchId}>{t("search")}</label>
                  <input
                    id={searchId}
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <ul>
                  {data.sources
                    .filter((source) =>
                      source.name
                        .toLocaleLowerCase(locale)
                        .includes(search.toLocaleLowerCase(locale)),
                    )
                    .map((source) => (
                      <li key={source.id}>
                        <button
                          type="button"
                          aria-current={
                            selected === source.id ? "true" : undefined
                          }
                          onClick={() => setSelected(source.id)}
                        >
                          <span>{source.name}</span>
                          <small>
                            {t(source.kind === "source" ? "raw" : source.kind)}
                            {source.kind === "manual" && projectName
                              ? " · " + t("allProjects")
                              : ""}
                            {source.rowCount !== null
                              ? " · " +
                                new Intl.NumberFormat(locale).format(
                                  source.rowCount,
                                ) +
                                " " +
                                t("rows").toLocaleLowerCase(locale)
                              : ""}
                          </small>
                        </button>
                      </li>
                    ))}
                </ul>
                {!data.sources.some((source) =>
                  source.name
                    .toLocaleLowerCase(locale)
                    .includes(search.toLocaleLowerCase(locale)),
                ) ? (
                  <p>{t("noMatch")}</p>
                ) : null}
              </aside>
              <section
                className="data-preview-panel"
                aria-labelledby="dataset-preview-title"
              >
                <div className="data-preview-header">
                  <div>
                    <h2 id="dataset-preview-title">
                      {selectedSource?.name ?? t("sample")}
                    </h2>
                    <p className="page-meta">{t("sampleHint")}</p>
                  </div>
                  <div className="actions">
                    {selectedSource?.kind === "manual" ? (
                      <button
                        type="button"
                        disabled={loading || !!referenceLoading}
                        onClick={() => void editReference()}
                      >
                        {t("editReference")}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="primary"
                      disabled={!preview || loading || !!referenceLoading}
                      onClick={() => {
                        setSection("preparations");
                        open({
                          kind: "preparation",
                          initial: null,
                          sourceId: selected,
                        });
                      }}
                    >
                      {t("prepare")}
                    </button>
                  </div>
                </div>
                {referenceLoading ? (
                  <p className="notice" role="status">
                    {t("referenceLoadProgress", referenceLoading)}{" "}
                    <button
                      type="button"
                      onClick={() => referenceAbort.current?.abort()}
                    >
                      {t("cancel")}
                    </button>
                  </p>
                ) : null}
                {selectedSource?.aggregated ? (
                  <p className="notice">{t("aggregatedHint")}</p>
                ) : null}
                {error ? (
                  <p className="error" role="alert">
                    {error}
                  </p>
                ) : null}
                {error ? (
                  <button
                    type="button"
                    onClick={() => setPreviewRevision((value) => value + 1)}
                  >
                    {t("retry")}
                  </button>
                ) : null}
                <DataTable
                  fields={preview?.fields ?? selectedSource?.fields ?? []}
                  rows={preview?.rows ?? []}
                  loading={loading}
                />
                <PreviewNotes warnings={preview?.warnings ?? []} />
              </section>
            </div>
          )}
        </>
      ) : section === "preparations" ? (
        <>
          {!data.preparations.length ? (
            <div className="data-empty">
              <h2>{t("emptyPreparations")}</h2>
              <p>{t("emptyPreparationsHint")}</p>
            </div>
          ) : (
            <div className="data-table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">{t("name")}</th>
                    <th scope="col">{t("draft")}</th>
                    <th scope="col">{t("output")}</th>
                    {canDelete ? (
                      <th scope="col">
                        <span className="visually-hidden">
                          {t("delete.action")}
                        </span>
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {data.preparations.map((preparation) => (
                    <tr key={preparation.id}>
                      <td>
                        <button
                          type="button"
                          className="link-button"
                          onClick={() =>
                            open({ kind: "preparation", initial: preparation })
                          }
                        >
                          {preparation.name}
                        </button>{" "}
                        {updateMark(preparation.id)}
                      </td>
                      <td>
                        {preparation.publishedVersion
                          ? t("published", {
                              version: preparation.publishedVersion,
                            })
                          : t("unpublished")}
                        {preparation.version !== preparation.publishedVersion
                          ? " · " + t("changed")
                          : ""}
                      </td>
                      <td>{preparation.graph.outputs.length}</td>
                      {canDelete ? (
                        <td className="data-row-actions">
                          {deleteButton(
                            "preparation",
                            preparation.id,
                            preparation.name,
                          )}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <>
          {!data.models.length ? (
            <div className="data-empty">
              <h2>{t("emptyModels")}</h2>
              <p>{t("emptyModelsHint")}</p>
            </div>
          ) : (
            <div className="data-table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">{t("name")}</th>
                    <th scope="col">{t("draft")}</th>
                    <th scope="col">{t("measures")}</th>
                    {canDelete ? (
                      <th scope="col">
                        <span className="visually-hidden">
                          {t("delete.action")}
                        </span>
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {data.models.map((model) => (
                    <tr key={model.id}>
                      <td>
                        <button
                          type="button"
                          className="link-button"
                          onClick={() =>
                            open({ kind: "model", initial: model })
                          }
                        >
                          {model.name}
                        </button>{" "}
                        {updateMark(model.id)}
                      </td>
                      <td>
                        {model.publishedVersion
                          ? t("published", { version: model.publishedVersion })
                          : t("unpublished")}
                        {model.version !== model.publishedVersion
                          ? " · " + t("changed")
                          : ""}
                      </td>
                      <td>{model.definition.measures.length}</td>
                      {canDelete ? (
                        <td className="data-row-actions">
                          {deleteButton("model", model.id, model.name)}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Why a delete was refused: what still uses the item (#671). */
export function DataInUseNotice({
  workspaceId,
  name,
  usedBy,
}: {
  workspaceId: string;
  name: string;
  usedBy: DataUsers;
}) {
  const t = useT("data");
  const hidden =
    usedBy.hidden.preparations +
    usedBy.hidden.models +
    usedBy.hidden.dashboards;
  return (
    <section className="error data-in-use" role="alert">
      <p>{t("delete.inUse", { name })}</p>
      <ul>
        {usedBy.preparations.map((item) => (
          <li key={item.id}>{t("delete.preparation", { name: item.name })}</li>
        ))}
        {usedBy.models.map((item) => (
          <li key={item.id}>{t("delete.model", { name: item.name })}</li>
        ))}
        {usedBy.dashboards.map((item) => (
          <li key={item.id}>
            <Link href={`/workspaces/${workspaceId}/dashboards/${item.id}`}>
              {t("delete.dashboard", { name: item.name })}
            </Link>
          </li>
        ))}
        {usedBy.storeTemplates.map((item) => (
          <li key={item.requestId}>
            {item.name
              ? t("delete.storeTemplate", { name: item.name })
              : t("delete.storeTemplateUnnamed")}
          </li>
        ))}
        {hidden ? <li>{t("delete.hidden", { count: hidden })}</li> : null}
      </ul>
    </section>
  );
}

/** What a refused delete means for the page (#671). */
export function deleteFailure(
  failure: unknown,
):
  | { kind: "gone" }
  | { kind: "inUse"; usedBy: DataUsers }
  | { kind: "forbidden" }
  | { kind: "busy" }
  | { kind: "other" } {
  if (!(failure instanceof ApiError)) return { kind: "other" };
  if (failure.status === 404) return { kind: "gone" };
  if (failure.status === 403) return { kind: "forbidden" };
  // Other data writes held the delete off (#671): nothing to reload.
  if (failure.code === "version_conflict") return { kind: "busy" };
  if (failure.code === "data_in_use" && failure.details.usedBy)
    return { kind: "inUse", usedBy: failure.details.usedBy };
  return { kind: "other" };
}
