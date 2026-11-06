"use client";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import {
  getDataWorkspace,
  previewData,
  readReference,
  type ReferenceTable,
  type DataWorkspace as WorkspaceData,
  type DataPreview,
  type PreparationDraft,
  type ModelDraft,
} from "@/lib/data-api";
import { dataErrorKey, newDataId } from "@/lib/data-editing";
import { useT, useLocale } from "@/lib/i18n/client";
import { useLeaveGuard } from "@/components/studio-editor/use-leave-guard";
import { DataTable } from "./data-table";
import { PreparationEditor } from "./preparation-editor";
import { ModelEditor } from "./model-editor";
import { ReferenceEditor } from "./reference-editor";
import { PreviewNotes } from "./preview-notes";

type Section = "datasets" | "preparations" | "models";
type Editor = { key: string } & (
  | { kind: "preparation"; initial: PreparationDraft | null; sourceId?: string }
  | { kind: "model"; initial: ModelDraft | null }
  | { kind: "reference"; initial?: ReferenceTable }
);
export function DataWorkspace({
  workspaceId,
  initial,
}: {
  workspaceId: string;
  initial: WorkspaceData;
}) {
  const t = useT("data"),
    locale = useLocale(),
    searchId = useId(),
    sourceSelectId = useId();
  const [data, setData] = useState(initial),
    [section, setSection] = useState<Section>("datasets");
  const [editor, setEditor] = useState<Editor | null>(null),
    [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState(initial.sources[0]?.id ?? ""),
    [search, setSearch] = useState("");
  const [preview, setPreview] = useState<DataPreview | null>(null),
    [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
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
      next();
    }
  }
  function open(value: Omit<Editor, "key"> | Editor) {
    leave(() => setEditor({ ...value, key: newDataId() } as Editor));
  }
  async function refresh() {
    try {
      const next = await getDataWorkspace(workspaceId);
      setData(next);
      if (!selected && next.sources[0]) setSelected(next.sources[0].id);
    } catch (failure) {
      setError(t(`errors.${dataErrorKey(failure)}`));
    }
  }
  function preparationSaved(draft: PreparationDraft) {
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
    setData((value) => ({
      ...value,
      models: [...value.models.filter((m) => m.id !== model.id), model],
    }));
  }
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
          <p className="page-meta">{t("subtitle")}</p>
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
      {editor?.kind === "preparation" ? (
        <PreparationEditor
          key={editor.key}
          workspaceId={workspaceId}
          sources={data.sources}
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
          sources={data.sources}
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
                        </button>
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
                        </button>
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
