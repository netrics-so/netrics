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
  restorePreparation,
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
import { DefinitionHistory } from "./definition-history";
import {
  PreparationEditError,
  preparationStepInputs,
  replacePreparationStep,
  removePreparationStep,
  movePreparationStep,
  preparationMoveProblem,
  preparationRemovalProblem,
} from "@/lib/preparation-editing";

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
  const [editing, setEditing] = useState<{
    node: PreparationNode;
    fields: DataField[];
  } | null>(null);
  const [removing, setRemoving] = useState(false),
    [bypass, setBypass] = useState("");
  const [adding, setAdding] = useState(false),
    [busy, setBusy] = useState<
      "preview" | "save" | "publish" | "history" | null
    >(null);
  const [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const request = useRef(0);
  const current = JSON.stringify({ name, graph }),
    dirty = current !== savedState || (!record && graph.nodes.length > 0);
  const currentOutput = graph.outputs.includes(selected)
    ? selected
    : (graph.outputs[0] ?? "");
  useEffect(() => {
    onDirty(dirty || adding || !!editing || removing);
    return () => onDirty(false);
  }, [dirty, adding, editing, removing, onDirty]);
  async function show(
    next: PreparationGraph,
    output: string,
    validateAll = false,
  ) {
    const sequence = ++request.current;
    setBusy("preview");
    setError(null);
    setNotice(null);
    try {
      const validation = validateAll
        ? await previewPreparation(
            workspaceId,
            next,
            record ? { id: record.id, version: record.version } : undefined,
          )
        : null;
      const result = validation?.outputs[output]
        ? validation
        : await previewPreparation(
            workspaceId,
            preparationAt(next, output),
            record ? { id: record.id, version: record.version } : undefined,
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
  async function restore(version?: number) {
    if (!record) return;
    setBusy("history");
    setError(null);
    setNotice(null);
    request.current++;
    try {
      const result =
        version === undefined
          ? await savePreparation(
              workspaceId,
              { name, graph, version: record.version, adoptLatestInputs: true },
              record.id,
            )
          : await restorePreparation(
              workspaceId,
              record.id,
              record.version,
              version,
            );
      const next = result.preparation;
      setRecord(next);
      setName(next.name);
      setGraph(next.graph);
      setSavedState(JSON.stringify({ name: next.name, graph: next.graph }));
      setHistory([]);
      setSelected(next.graph.outputs[0] ?? "");
      setAdding(false);
      setEditing(null);
      setRemoving(false);
      setPreview(null);
      setPreviewState("");
      onSaved(next);
      setNotice(
        t(version === undefined ? "latestInputsNotice" : "restoredNotice"),
      );
    } catch (failure) {
      setError(t(`errors.${dataErrorKey(failure)}`));
    } finally {
      setBusy(null);
    }
  }
  const initialSource = graph.nodes.find((n) => n.type === "source");
  function changeSource(id: string) {
    const outputId = initialSource?.id ?? "source";
    const next: PreparationGraph = initialSource
      ? replacePreparationStep(graph, outputId, [
          { ...initialSource, datasetId: id },
        ])
      : {
          version: 1,
          nodes: [{ id: outputId, type: "source", datasetId: id }],
          outputs: [outputId],
        };
    setHistory((list) => [...list, graph]);
    setGraph(next);
    setSelected(outputId);
    setAdding(false);
    void show(next, outputId).catch(() => undefined);
  }
  const fields: DataField[] = preview?.fields ?? [];
  const selectedNode = graph.nodes.find((node) => node.id === selected);
  const moveUp = selectedNode
    ? preparationMoveProblem(graph, selected, "up")
    : "missingStep";
  const moveDown = selectedNode
    ? preparationMoveProblem(graph, selected, "down")
    : "missingStep";
  const removal = selectedNode
    ? preparationRemovalProblem(graph, selected)
    : "missingStep";
  const formOpen = adding || !!editing || removing;
  const nodeLabel = (nodeId: string) => {
    const node = graph.nodes.find((node) => node.id === nodeId);
    return node?.type === "source"
      ? (sources.find((source) => source.id === node.datasetId)?.name ??
          node.datasetId)
      : node?.type === "calculate"
        ? node.name
        : node
          ? t(node.type)
          : nodeId;
  };
  async function editSelected() {
    if (!selectedNode) return;
    const sequence = ++request.current;
    setBusy("preview");
    setError(null);
    setNotice(null);
    try {
      const inputId =
        selectedNode.type === "append"
          ? undefined
          : preparationStepInputs(selectedNode)[0];
      const input = inputId
        ? await previewPreparation(
            workspaceId,
            preparationAt(graph, inputId),
            record ? { id: record.id, version: record.version } : undefined,
          )
        : null;
      if (sequence === request.current)
        setEditing({
          node: selectedNode,
          fields:
            selectedNode.type === "append"
              ? (preview?.fields ?? [])
              : inputId
                ? input!.outputs[inputId]!.fields
                : [],
        });
    } catch (failure) {
      if (sequence === request.current)
        setError(t(`errors.${dataErrorKey(failure)}`));
    } finally {
      if (sequence === request.current) setBusy(null);
    }
  }
  async function changeGraph(next: PreparationGraph, output: string) {
    await show(next, output, true);
    setHistory((list) => [...list, graph]);
    setGraph(next);
  }
  async function move(direction: "up" | "down") {
    try {
      await changeGraph(
        movePreparationStep(graph, selected, direction),
        selected,
      );
    } catch (failure) {
      if (failure instanceof PreparationEditError)
        setError(t(`editErrors.${failure.problem}`));
    }
  }
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
              !!busy ||
              adding ||
              !!editing ||
              removing ||
              !name.trim() ||
              !graph.nodes.length ||
              !dirty
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
              !!editing ||
              removing ||
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
      {record ? (
        <DefinitionHistory
          workspaceId={workspaceId}
          kind="preparations"
          id={record.id}
          publishedVersion={record.publishedVersion}
          restoredFromVersion={record.restoredFromVersion}
          disabled={!!busy || formOpen}
          unsaved={dirty}
          onRestore={restore}
          onAdoptLatest={() => restore()}
        />
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
                  disabled={!!busy || adding || !!editing || removing}
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
              !!editing ||
              removing ||
              !preview ||
              !graph.outputs.includes(selected)
            }
            onClick={() => setAdding(true)}
          >
            {t("addStep")}
          </button>
          <button
            type="button"
            disabled={
              !history.length || !!busy || adding || !!editing || removing
            }
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
          {record?.publishedVersion ? (
            <p className="help">{t("preparationAdoptionHint")}</p>
          ) : null}
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
          {selectedNode ? (
            <div className="data-step-actions">
              <div className="data-form-actions">
                <button
                  type="button"
                  disabled={!!busy || formOpen}
                  onClick={() => void editSelected()}
                >
                  {t("editStep")}
                </button>
                <button
                  type="button"
                  disabled={!!busy || formOpen || !!moveUp}
                  title={moveUp ? t(`editErrors.${moveUp}`) : undefined}
                  onClick={() => void move("up")}
                >
                  {t("moveStepUp")}
                </button>
                <button
                  type="button"
                  disabled={!!busy || formOpen || !!moveDown}
                  title={moveDown ? t(`editErrors.${moveDown}`) : undefined}
                  onClick={() => void move("down")}
                >
                  {t("moveStepDown")}
                </button>
                <button
                  type="button"
                  disabled={!!busy || formOpen || !!removal}
                  title={removal ? t(`editErrors.${removal}`) : undefined}
                  onClick={() => {
                    setBypass(preparationStepInputs(selectedNode)[0] ?? "");
                    setRemoving(true);
                  }}
                >
                  {t("removeStep")}
                </button>
              </div>
              <p className="help">
                {graph.outputs.includes(selected)
                  ? removal
                    ? t("editErrors.outputIdentity")
                    : t("outputRemovalHint")
                  : t("stepMoveHint")}
              </p>
              {formOpen ? <p className="help">{t("finishStep")}</p> : null}
            </div>
          ) : null}
          {removing && selectedNode ? (
            <div
              className="data-step-form"
              role="group"
              aria-label={t("removeStep")}
            >
              <p>{t("removeStepHint")}</p>
              {preparationStepInputs(selectedNode).length > 1 ? (
                <label className="field">
                  {t("continueInput")}
                  <select
                    value={bypass}
                    onChange={(event) => setBypass(event.target.value)}
                  >
                    {preparationStepInputs(selectedNode).map((nodeId) => (
                      <option key={nodeId} value={nodeId}>
                        {nodeLabel(nodeId)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <div className="data-form-actions">
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => {
                    try {
                      const next = removePreparationStep(
                        graph,
                        selected,
                        bypass,
                      );
                      void changeGraph(
                        next,
                        next.nodes.some((node) => node.id === selected)
                          ? selected
                          : next.outputs[0]!,
                      )
                        .then(() => setRemoving(false))
                        .catch(() => undefined);
                    } catch (failure) {
                      if (failure instanceof PreparationEditError)
                        setError(t(`editErrors.${failure.problem}`));
                    }
                  }}
                >
                  {t("removeStep")}
                </button>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => {
                    setRemoving(false);
                    void show(graph, selected).catch(() => undefined);
                  }}
                >
                  {t("cancel")}
                </button>
              </div>
            </div>
          ) : null}
          {editing ? (
            <StepForm
              key={editing.node.id}
              workspaceId={workspaceId}
              input={preparationStepInputs(editing.node)[0] ?? ""}
              graph={graph}
              initial={editing.node}
              fields={editing.fields}
              sources={sources.filter(
                (source) =>
                  !record ||
                  !source.id.startsWith("prepared:" + record.id + ":"),
              )}
              busy={!!busy}
              onCancel={() => {
                setEditing(null);
                void show(graph, selected).catch(() => undefined);
              }}
              onApply={async (nodes) => {
                await changeGraph(
                  replacePreparationStep(graph, editing.node.id, nodes),
                  editing.node.id,
                );
                setEditing(null);
              }}
            />
          ) : null}
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
              graph={graph}
              sources={sources.filter(
                (s) =>
                  !record || !s.id.startsWith("prepared:" + record.id + ":"),
              )}
              busy={!!busy}
              onCancel={() => {
                setAdding(false);
                void show(graph, currentOutput).catch(() => undefined);
              }}
              onApply={async (nodes) => {
                const next = appendPreparation(graph, nodes, currentOutput);
                await changeGraph(next, currentOutput);
                setAdding(false);
              }}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
