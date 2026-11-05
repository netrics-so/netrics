"use client";
import { useEffect, useId, useRef, useState } from "react";
import type {
  DataField,
  PreparationGraph,
  PreparationNode,
} from "@netrics/domain";
import { formatDataFormula } from "@netrics/domain";
import {
  previewPreparation,
  savePreparation,
  publishPreparation,
  type DataSource,
  type PreparationDraft,
  type DataPreview,
} from "@/lib/data-api";
import {
  appendPreparation,
  preparationAt,
  dataErrorKey,
} from "@/lib/data-editing";
import { useT } from "@/lib/i18n/client";
import { DataTable } from "./data-table";
import { StepForm } from "./step-form";
import { PreviewNotes } from "./preview-notes";

export function PreparationEditor({
  workspaceId,
  sources,
  initial,
  sourceId,
  onSaved,
  onClose,
  onDirty,
}: {
  workspaceId: string;
  sources: DataSource[];
  initial: PreparationDraft | null;
  sourceId?: string;
  onSaved: (draft: PreparationDraft) => void;
  onClose: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const t = useT("data"),
    nameId = useId(),
    sourceSelectId = useId();
  const [record, setRecord] = useState(initial);
  const [name, setName] = useState(initial?.name ?? t("defaultPreparation"));
  const [graph, setGraph] = useState<PreparationGraph>(
    initial?.graph ?? {
      version: 1,
      nodes: sourceId
        ? [{ id: "source", type: "source", datasetId: sourceId }]
        : [],
      outputs: sourceId ? ["source"] : [],
    },
  );
  const [savedState, setSavedState] = useState(
    JSON.stringify({
      name: initial?.name ?? t("defaultPreparation"),
      graph: initial?.graph ?? graph,
    }),
  );
  const [history, setHistory] = useState<PreparationGraph[]>([]),
    [selected, setSelected] = useState(graph.outputs[0] ?? "");
  const [preview, setPreview] = useState<DataPreview | null>(null),
    [previewState, setPreviewState] = useState("");
  const [adding, setAdding] = useState(false),
    [busy, setBusy] = useState<"preview" | "save" | "publish" | null>(null);
  const [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const request = useRef(0);
  const current = JSON.stringify({ name, graph }),
    dirty = current !== savedState || (!record && graph.nodes.length > 0);
  const currentOutput = graph.outputs.includes(selected)
    ? selected
    : (graph.outputs[0] ?? "");
  useEffect(() => {
    onDirty(dirty || adding);
    return () => onDirty(false);
  }, [dirty, adding, onDirty]);
  async function show(next: PreparationGraph, output: string) {
    const sequence = ++request.current;
    setBusy("preview");
    setError(null);
    setNotice(null);
    try {
      const result = await previewPreparation(
        workspaceId,
        preparationAt(next, output),
      );
      if (sequence !== request.current) return;
      const table = result.outputs[output]!;
      setPreview({ ...table, warnings: result.warnings });
      setSelected(output);
      setPreviewState(JSON.stringify(next));
    } catch (failure) {
      if (sequence === request.current) {
        setError(t(`errors.${dataErrorKey(failure)}`));
        setPreview(null);
      }
      throw failure;
    } finally {
      if (sequence === request.current) setBusy(null);
    }
  }
  useEffect(() => {
    if (graph.outputs[0])
      void show(graph, graph.outputs[0]).catch(() => undefined);
    return () => {
      request.current++;
    };
    // Initial preview only; later edits are explicitly previewed.
  }, []);
  async function persist(publish: boolean) {
    setError(null);
    setNotice(null);
    setBusy(publish ? "publish" : "save");
    try {
      const result =
        record && !dirty
          ? { preparation: record }
          : await savePreparation(
              workspaceId,
              {
                name: name.trim(),
                graph,
                ...(record ? { version: record.version } : {}),
              },
              record?.id,
            );
      setRecord(result.preparation);
      setSavedState(current);
      onSaved(result.preparation);
      if (publish) {
        const published = await publishPreparation(
          workspaceId,
          result.preparation.id,
          result.preparation.version,
        );
        setRecord(published.preparation);
        onSaved(published.preparation);
        setNotice(t("publishedNotice"));
      } else setNotice(t("saved"));
    } catch (failure) {
      setError(t(`errors.${dataErrorKey(failure)}`));
    } finally {
      setBusy(null);
    }
  }
  const initialSource = graph.nodes.find((n) => n.type === "source");
  function changeSource(id: string) {
    const next: PreparationGraph = {
      version: 1,
      nodes: [{ id: "source", type: "source", datasetId: id }],
      outputs: ["source"],
    };
    setHistory((list) => [...list, graph]);
    setGraph(next);
    setSelected("source");
    setAdding(false);
    void show(next, "source").catch(() => undefined);
  }
  const fields: DataField[] = preview?.fields ?? [];
  return (
    <section className="data-editor" aria-labelledby="preparation-title">
      <header className="data-editor-header">
        <div>
          <button type="button" className="link-button" onClick={onClose}>
            {t("back")}
          </button>
          <h2 id="preparation-title">{name || t("defaultPreparation")}</h2>
          <p className="page-meta">
            {record?.publishedVersion
              ? t("published", { version: record.publishedVersion })
              : t("unpublished")}
            {dirty ? " · " + t("changed") : ""}
          </p>
        </div>
        <div className="data-form-actions">
          <button
            type="button"
            disabled={
              !!busy || adding || !name.trim() || !graph.nodes.length || !dirty
            }
            onClick={() => void persist(false)}
          >
            {t(busy === "save" ? "saving" : "save")}
          </button>
          <button
            type="button"
            className="primary"
            disabled={
              !!busy ||
              adding ||
              !name.trim() ||
              !graph.nodes.length ||
              previewState !== JSON.stringify(graph) ||
              !!error
            }
            onClick={() => void persist(true)}
          >
            {t(busy === "publish" ? "publishing" : "publish")}
          </button>
        </div>
      </header>
      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}
      <div className="data-builder">
        <aside className="data-steps">
          <div className="field">
            <label htmlFor={nameId}>{t("preparationName")}</label>
            <input
              id={nameId}
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!!busy}
            />
          </div>
          {!initial || graph.nodes.length <= 1 ? (
            <div className="field">
              <label htmlFor={sourceSelectId}>{t("sourceName")}</label>
              <select
                id={sourceSelectId}
                value={
                  initialSource?.type === "source"
                    ? initialSource.datasetId
                    : ""
                }
                disabled={!!busy || graph.nodes.length > 1}
                onChange={(e) => changeSource(e.target.value)}
              >
                <option value="" disabled>
                  {t("chooseSource")}
                </option>
                {sources
                  .filter(
                    (source) =>
                      !initial ||
                      !source.id.startsWith("prepared:" + initial.id + ":"),
                  )
                  .map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.name}
                    </option>
                  ))}
              </select>
            </div>
          ) : null}
          <h3>{t("steps")}</h3>
          <ol className="data-step-list">
            {graph.nodes.map((node) => (
              <li key={node.id}>
                <button
                  type="button"
                  aria-current={node.id === selected ? "step" : undefined}
                  disabled={!!busy}
                  onClick={() => {
                    setAdding(false);
                    void show(graph, node.id).catch(() => undefined);
                  }}
                >
                  <span>
                    {node.type === "source"
                      ? (sources.find((s) => s.id === node.datasetId)?.name ??
                        t("source"))
                      : t(node.type)}
                  </span>
                  {node.type === "calculate" ? (
                    <small>{node.name}</small>
                  ) : null}
                </button>
              </li>
            ))}
          </ol>
          <button
            type="button"
            disabled={
              !graph.outputs.length ||
              !!busy ||
              adding ||
              !preview ||
              !graph.outputs.includes(selected)
            }
            onClick={() => setAdding(true)}
          >
            {t("addStep")}
          </button>
          <button
            type="button"
            disabled={!history.length || !!busy}
            onClick={() => {
              const previous = history.at(-1)!;
              setHistory((list) => list.slice(0, -1));
              setGraph(previous);
              setAdding(false);
              if (previous.outputs[0])
                void show(previous, previous.outputs[0]).catch(() => undefined);
              else {
                setPreview(null);
                setSelected("");
              }
            }}
          >
            {t("undo")}
          </button>
          <p className="page-meta">{t("outputHint")}</p>
        </aside>
        <div className="data-preview-panel">
          <div className="data-preview-header">
            <div>
              <h3>{t("sample")}</h3>
              <p className="page-meta">{t("sampleHint")}</p>
            </div>
            <button
              type="button"
              disabled={!!busy || !selected}
              onClick={() => void show(graph, selected).catch(() => undefined)}
            >
              {t(busy === "preview" ? "previewing" : "preview")}
            </button>
          </div>
          <DataTable
            fields={fields}
            rows={preview?.rows ?? []}
            loading={busy === "preview"}
            focusColumn={
              graph.nodes.find((node) => node.id === selected)?.type ===
              "calculate"
                ? (
                    graph.nodes.find((node) => node.id === selected) as Extract<
                      PreparationNode,
                      { type: "calculate" }
                    >
                  ).fieldId
                : undefined
            }
          />
          <PreviewNotes warnings={preview?.warnings ?? []} />
          {selected &&
          graph.nodes.find((n) => n.id === selected)?.type === "calculate" ? (
            <p className="data-formula-summary">
              {formatDataFormula(
                (
                  graph.nodes.find((n) => n.id === selected) as Extract<
                    PreparationNode,
                    { type: "calculate" }
                  >
                ).expression,
                fields,
              )}
            </p>
          ) : null}
          {adding && preview ? (
            <StepForm
              key={currentOutput}
              workspaceId={workspaceId}
              input={currentOutput}
              fields={fields}
              sources={sources.filter(
                (s) =>
                  !record || !s.id.startsWith("prepared:" + record.id + ":"),
              )}
              busy={!!busy}
              onCancel={() => setAdding(false)}
              onApply={async (nodes) => {
                const next = appendPreparation(graph, nodes, currentOutput);
                await show(next, nodes.at(-1)!.id);
                setHistory((list) => [...list, graph]);
                setGraph(next);
                setAdding(false);
              }}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
