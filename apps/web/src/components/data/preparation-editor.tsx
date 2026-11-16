"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  DataField,
  PreparationGraph,
  PreparationNode,
} from "@netrics/domain";
import { canonicalJson, formatDataFormula } from "@netrics/domain";
import {
  previewPreparation,
  savePreparation,
  publishPreparation,
  readDataImpact,
  restorePreparation,
  type DataSource,
  type PreparationDraft,
  type DataPreview,
} from "@/lib/data-api";
import {
  appendPreparation,
  preparationAt,
  dataErrorKey,
  dataErrorLocation,
  hasUnpublishedChanges,
} from "@/lib/data-editing";
import { useT } from "@/lib/i18n/client";
import { DataTable } from "./data-table";
import { StepForm } from "./step-form";
import { PreviewNotes } from "./preview-notes";
import { DefinitionHistory } from "./definition-history";
import {
  recordChange,
  recordEdit,
  redoEdit,
  startHistory,
  undoEdit,
} from "@/lib/edit-history";
import { useDraftSources } from "@/lib/data-source-metadata";
import {
  PreparationEditError,
  preparationStepInputs,
  replacePreparationStep,
  removePreparationStep,
  movePreparationStep,
  preparationMoveProblem,
  preparationRemovalProblem,
  preparationStepFailure,
  preparationStepStates,
  preparationFieldName,
  preparationChangeFailure,
  preparationChangeRejection,
  preparationStepErrorKey,
  PreparationStepFailureShown,
} from "@/lib/preparation-editing";
import { PreparationStepList } from "./preparation-step-list";
import {
  publishAfterConfirmation,
  useImpactConfirmation,
} from "./publish-impact-dialog";

export function PreparationEditor({
  workspaceId,
  sources: sourceCatalog,
  initial,
  sourceId,
  projectId = null,
  onSaved,
  onClose,
  onDirty,
}: {
  workspaceId: string;
  sources: DataSource[];
  initial: PreparationDraft | null;
  sourceId?: string;
  /** The project a new preparation starts in (#573). */
  projectId?: string | null;
  onSaved: (draft: PreparationDraft) => void;
  onClose: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const t = useT("data"),
    nameId = useId(),
    sourceSelectId = useId();
  const [record, setRecord] = useState(initial);
  const inputMetadata = useDraftSources(
    workspaceId,
    "preparations",
    record,
    sourceCatalog,
  );
  const sources = inputMetadata.sources;
  const [name, setName] = useState(initial?.name ?? t("defaultPreparation"));
  const [graphHistory, setGraphHistory] = useState(() =>
    startHistory<PreparationGraph>(
      initial?.graph ?? {
        version: 1,
        nodes: sourceId
          ? [{ id: "source", type: "source", datasetId: sourceId }]
          : [],
        outputs: sourceId ? ["source"] : [],
      },
    ),
  );
  const graph = graphHistory.present;
  const [savedState, setSavedState] = useState(
    canonicalJson({
      name: initial?.name ?? t("defaultPreparation"),
      graph: initial?.graph ?? graph,
    }),
  );
  const [selected, setSelected] = useState(graph.outputs[0] ?? "");
  const [preview, setPreview] = useState<DataPreview | null>(null),
    [previewState, setPreviewState] = useState(""),
    // The sample is the last valid one, from before a check that failed.
    [previewStale, setPreviewStale] = useState(false);
  const [editing, setEditing] = useState<{
    node: PreparationNode;
    fields: DataField[];
  } | null>(null);
  const [removing, setRemoving] = useState(false),
    [bypass, setBypass] = useState("");
  const [adding, setAdding] = useState(false),
    // A graph with an output is checked once the editor mounts, so it starts
    // busy: the server markup, and the page until that check returns, offer
    // no step or action that hydration or the check would drop (#729).
    [busy, setBusy] = useState<
      "preview" | "save" | "publish" | "history" | null
    >(graph.outputs[0] ? "preview" : null);
  const [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  // A data error attributed to one step, kept with the graph it was found in.
  // It is shown only while that graph is the current one, so undo, edits and
  // restores never leave a marker on a step that changed or no longer exists.
  const [stepError, setStepError] = useState<{
    graph: string;
    nodeId: string;
    fieldId?: string;
    key: ReturnType<typeof preparationStepErrorKey>;
  } | null>(null);
  // A step change whose own step failed: not applied, shown in the step list
  // with the failure while its form stays open (#643).
  const [proposal, setProposal] = useState<PreparationGraph | null>(null);
  const request = useRef(0);
  const confirmation = useImpactConfirmation(
    name.trim() || t("defaultPreparation"),
  );
  const current = useMemo(() => canonicalJson({ name, graph }), [name, graph]),
    dirty = current !== savedState || (!record && graph.nodes.length > 0);
  const graphSignature = useMemo(() => canonicalJson(graph), [graph]);
  // The published graph, when known: undoing back to it clears the mark
  // (the server reports differing inputs separately).
  const [publishedGraph, setPublishedGraph] = useState(() =>
    // The server says whether a saved draft equals the release (#697).
    initial?.publishedVersion &&
    (initial.publishedVersion === initial.version ||
      initial.hasUnpublishedChanges === false)
      ? canonicalJson(initial.graph)
      : undefined,
  );
  // The saved draft's graph, in the published state's form.
  const savedRelease = useMemo(
    () => (record ? canonicalJson(record.graph) : undefined),
    [record],
  );
  const unpublishedChanges = hasUnpublishedChanges({
    version: record?.version,
    publishedVersion: record?.publishedVersion,
    savedDiffers: record?.hasUnpublishedChanges,
    inputsDiffer: record?.inputsDiffer,
    saved: savedRelease,
    published: publishedGraph,
    current: graphSignature,
    dirty,
  });
  const formOpen = adding || !!editing || removing;
  // While a failed change's form is open, the list shows the proposed graph.
  const listGraph = formOpen && proposal ? proposal : graph;
  const listSignature = useMemo(() => canonicalJson(listGraph), [listGraph]);
  const shownStepError = stepError?.graph === listSignature ? stepError : null;
  useEffect(() => {
    if (!adding && !editing) setProposal(null);
  }, [adding, editing]);
  /** Mark the failing step when the error names one in `failed`; otherwise show the banner. */
  function reportFailure(failure: unknown, failed: PreparationGraph) {
    const step = preparationStepFailure(dataErrorLocation(failure), failed);
    if (step)
      setStepError({
        graph: canonicalJson(failed),
        ...step,
        key: preparationStepErrorKey(failure, failed, step.nodeId),
      });
    else setError(t(`errors.${dataErrorKey(failure)}`));
    return step;
  }
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
    // The saved draft to check against; a restore passes the record it just received.
    saved: PreparationDraft | null = record,
  ) {
    const sequence = ++request.current;
    const draft = saved ? { id: saved.id, version: saved.version } : undefined;
    setBusy("preview");
    setError(null);
    setNotice(null);
    try {
      const validation = validateAll
        ? await previewPreparation(workspaceId, next, draft)
        : null;
      const result = validation?.outputs[output]
        ? validation
        : await previewPreparation(
            workspaceId,
            preparationAt(next, output),
            draft,
          );
      if (sequence !== request.current) return;
      const table = result.outputs[output]!;
      setPreview({ ...table, warnings: result.warnings });
      setSelected(output);
      setPreviewState(canonicalJson(next));
      setPreviewStale(false);
      // Only a check of every output proves the marked step is fixed.
      if (validateAll) setStepError(null);
    } catch (failure) {
      if (sequence === request.current) {
        const step = reportFailure(failure, next);
        const shown = preparationAt(next, output);
        if (
          step &&
          validateAll &&
          !shown.nodes.some((node) => node.id === step.nodeId)
        ) {
          // The failure is in another branch: this step still previews.
          try {
            const result = await previewPreparation(workspaceId, shown, draft);
            if (sequence === request.current) {
              setPreview({
                ...result.outputs[output]!,
                warnings: result.warnings,
              });
              setSelected(output);
              setPreviewState(canonicalJson(next));
              setPreviewStale(false);
            }
          } catch {
            if (sequence === request.current) setPreviewStale(true);
          }
          // Keep the last valid sample, marked as out of date, so an open
          // step form and its columns stay usable (#629, #643).
        } else setPreviewStale(true);
      }
      throw failure;
    } finally {
      if (sequence === request.current) setBusy(null);
    }
  }
  useEffect(() => {
    if (graph.outputs[0])
      void show(graph, graph.outputs[0], true).catch(() => undefined);
    return () => {
      request.current++;
    };
    // Initial preview only; later edits are explicitly previewed.
  }, []);
  async function persist(publish: boolean) {
    if (inputMetadata.loading || inputMetadata.error) return;
    setError(null);
    setNotice(null);
    setBusy(publish ? "publish" : "save");
    let saved = false;
    const save = async () => {
      const result =
        record && !dirty
          ? { preparation: record }
          : await savePreparation(
              workspaceId,
              {
                name: name.trim(),
                graph,
                ...(record ? { version: record.version } : { projectId }),
              },
              record?.id,
            );
      saved = result.preparation !== record;
      setRecord(result.preparation);
      setSavedState(current);
      onSaved(result.preparation);
      return result.preparation;
    };
    try {
      if (!publish) {
        await save();
        setNotice(t("saved"));
        return;
      }
      const outcome = await publishAfterConfirmation({
        save,
        confirm: (draft) =>
          confirmation.ask(async () => ({
            impact: await readDataImpact(workspaceId, {
              kind: "preparation",
              id: draft.id,
            }),
          })),
        publish: async (draft) => {
          const published = await publishPreparation(
            workspaceId,
            draft.id,
            draft.version,
          );
          setRecord(published.preparation);
          setPublishedGraph(canonicalJson(published.preparation.graph));
          onSaved(published.preparation);
        },
      });
      if (outcome === "published") setNotice(t("publishedNotice"));
      else if (saved) setNotice(t("saved"));
    } catch (failure) {
      // Publishing checks every step and can fail at one.
      reportFailure(failure, graph);
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
    let restored: PreparationDraft | null = null;
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
      // Restoring the live release shows the published graph.
      if (version !== undefined && version === record.publishedVersion)
        setPublishedGraph(canonicalJson(next.graph));
      setName(next.name);
      setGraphHistory(startHistory(next.graph));
      setSavedState(canonicalJson({ name: next.name, graph: next.graph }));
      setSelected(next.graph.outputs[0] ?? "");
      setAdding(false);
      setEditing(null);
      setRemoving(false);
      setPreview(null);
      setPreviewState("");
      onSaved(next);
      restored = next;
    } catch (failure) {
      setError(t(`errors.${dataErrorKey(failure)}`));
    } finally {
      setBusy(null);
    }
    if (!restored) return;
    // The restored graph can equal the one with a marked step (adopting the
    // latest inputs never changes it), so check every output again: a passing
    // check clears the marker, a failing one marks the step for this graph.
    const output = restored.graph.outputs[0];
    if (output)
      void show(restored.graph, output, true, restored).catch(() => undefined);
    else setStepError(null);
    // After show(), which clears notices when it starts.
    setNotice(
      t(version === undefined ? "latestInputsNotice" : "restoredNotice"),
    );
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
    setGraphHistory((h) => recordEdit(h, next));
    setSelected(outputId);
    setAdding(false);
    void show(next, outputId).catch(() => undefined);
  }
  const fields: DataField[] = preview?.fields ?? [];
  const selectedNode = graph.nodes.find((node) => node.id === selected);
  // The open step form's panel sits between the step list and the sample,
  // outside the sample's scrolling table, and takes focus when it opens
  // (#628).
  const stepFormTitle =
    removing && selectedNode
      ? ("removeStep" as const)
      : editing
        ? ("editStep" as const)
        : adding && preview
          ? ("addStep" as const)
          : null;
  const stepPanel = useRef<HTMLElement>(null),
    stepPanelTitleId = useId();
  useEffect(() => {
    if (stepFormTitle) stepPanel.current?.focus();
  }, [stepFormTitle]);
  // A form kept open after a failed check keeps focus in its panel: the
  // apply button it was on is disabled while the check runs.
  useEffect(() => {
    const panel = stepPanel.current;
    if (
      panel &&
      !busy &&
      (!document.activeElement || document.activeElement === document.body)
    )
      panel.focus();
  }, [busy, stepFormTitle]);
  // When the form closes (applied, cancelled, removed), focus goes back to
  // the control that opened it, or to the selected step when that control
  // is no longer available.
  const openForm = removing
    ? ("removeStep" as const)
    : editing
      ? ("editStep" as const)
      : adding
        ? ("addStep" as const)
        : null;
  const openers = useRef<
      Partial<Record<NonNullable<typeof openForm>, HTMLButtonElement | null>>
    >({}),
    stepsAside = useRef<HTMLElement>(null),
    lastForm = useRef(openForm);
  const [returnFocus, setReturnFocus] = useState<typeof openForm>(null);
  useEffect(() => {
    if (lastForm.current && !openForm) setReturnFocus(lastForm.current);
    lastForm.current = openForm;
  }, [openForm]);
  useEffect(() => {
    if (!returnFocus || busy) return;
    setReturnFocus(null);
    const opener = openers.current[returnFocus];
    (opener && !opener.disabled
      ? opener
      : stepsAside.current?.querySelector<HTMLButtonElement>(
          '[aria-current="step"]:not(:disabled)',
        )
    )?.focus();
  }, [returnFocus, busy]);
  const moveUp = selectedNode
    ? preparationMoveProblem(graph, selected, "up")
    : "missingStep";
  const moveDown = selectedNode
    ? preparationMoveProblem(graph, selected, "down")
    : "missingStep";
  const removal = selectedNode
    ? preparationRemovalProblem(graph, selected)
    : "missingStep";
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
      if (sequence === request.current) reportFailure(failure, graph);
    } finally {
      if (sequence === request.current) setBusy(null);
    }
  }
  /**
   * Check `next` and apply it. A failure in a step the change did not touch
   * still applies the change and marks that step, so it can be fixed or
   * undone; a failure in a changed step rejects the change.
   */
  async function changeGraph(
    next: PreparationGraph,
    output: string,
    changedIds: string[],
    // A step form is open for the change and can show its failure.
    fromForm = false,
  ) {
    // What the sample and the step markers showed before the check: a
    // refused change leaves the graph, and so both, as they were (#654).
    const staleBefore = previewStale,
      stepErrorBefore = stepError;
    try {
      await show(next, output, true);
    } catch (failure) {
      const outcome = preparationChangeFailure(failure, next, changedIds);
      const reaction = preparationChangeRejection(
        outcome,
        fromForm,
        staleBefore,
      );
      setProposal(reaction.proposal ? next : null);
      if (reaction.previewStale !== null) {
        setPreviewStale(reaction.previewStale);
        // The check marked the refused graph; the shown one keeps its mark.
        setStepError(stepErrorBefore);
      }
      if (reaction.banner === "clear") setError(null);
      if (reaction.banner === "step")
        setError(
          t(
            `errors.${preparationStepErrorKey(
              failure,
              next,
              dataErrorLocation(failure).nodeId!,
            )}`,
          ),
        );
      // The list shows it on the proposed step; the form shows nothing more.
      if (reaction.proposal)
        throw new PreparationStepFailureShown(dataErrorLocation(failure));
      if (outcome !== "applied") throw failure;
    }
    // A step applied unchanged leaves no undo step.
    setGraphHistory((h) => recordChange(h, next));
  }
  async function move(direction: "up" | "down") {
    try {
      await changeGraph(
        movePreparationStep(graph, selected, direction),
        selected,
        [selected],
      );
    } catch (failure) {
      if (failure instanceof PreparationEditError)
        setError(t(`editErrors.${failure.problem}`));
    }
  }
  return (
    <section className="data-editor" aria-labelledby="preparation-title">
      {confirmation.dialog}
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
            {unpublishedChanges ? " · " + t("changed") : ""}
          </p>
        </div>
        <div className="data-form-actions">
          <button
            type="button"
            disabled={
              !!busy ||
              inputMetadata.loading ||
              !!inputMetadata.error ||
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
              inputMetadata.loading ||
              !!inputMetadata.error ||
              adding ||
              !!editing ||
              removing ||
              !name.trim() ||
              !graph.nodes.length ||
              previewState !== graphSignature ||
              !!error ||
              !!shownStepError
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
      {inputMetadata.loading ? (
        <p role="status" className="page-meta">
          {t("loadingInputVersions")}
        </p>
      ) : null}
      {inputMetadata.error ? (
        <div role="alert">
          <p className="error">
            {t(`errors.${dataErrorKey(inputMetadata.error)}`)}
          </p>
          <button type="button" onClick={inputMetadata.retry}>
            {t("retry")}
          </button>
        </div>
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
      <div className="data-preparation-layout">
        <aside className="data-steps" ref={stepsAside}>
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
                disabled={
                  !!busy ||
                  inputMetadata.loading ||
                  !!inputMetadata.error ||
                  graph.nodes.length > 1
                }
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
          <PreparationStepList
            nodes={listGraph.nodes}
            selected={selected}
            states={
              shownStepError
                ? preparationStepStates(listGraph, shownStepError.nodeId)
                : new Map()
            }
            failure={
              shownStepError
                ? {
                    message: t(`errors.${shownStepError.key}`),
                    ...(shownStepError.fieldId
                      ? {
                          column: preparationFieldName(
                            listGraph,
                            sources,
                            shownStepError.fieldId,
                            fields,
                          ),
                        }
                      : {}),
                  }
                : null
            }
            label={(node) => ({
              title:
                node.type === "source"
                  ? (sources.find((s) => s.id === node.datasetId)?.name ??
                    t("source"))
                  : t(node.type),
              ...(node.type === "calculate" ? { detail: node.name } : {}),
            })}
            disabled={
              !!busy ||
              inputMetadata.loading ||
              !!inputMetadata.error ||
              adding ||
              !!editing ||
              removing
            }
            onSelect={(nodeId) => {
              setAdding(false);
              void show(graph, nodeId).catch(() => undefined);
            }}
          />
          <button
            type="button"
            disabled={
              !graph.outputs.length ||
              !!busy ||
              inputMetadata.loading ||
              !!inputMetadata.error ||
              adding ||
              !!editing ||
              removing ||
              !preview ||
              previewStale ||
              !graph.outputs.includes(selected)
            }
            ref={(button) => {
              openers.current.addStep = button;
            }}
            onClick={() => setAdding(true)}
          >
            {t("addStep")}
          </button>
          {(
            [
              ["undo", undoEdit, graphHistory.past.length],
              ["redo", redoEdit, graphHistory.future.length],
            ] as const
          ).map(([key, step, available]) => (
            <button
              key={key}
              type="button"
              disabled={
                !available ||
                !!busy ||
                inputMetadata.loading ||
                !!inputMetadata.error ||
                adding ||
                !!editing ||
                removing
              }
              onClick={() => {
                const present = step(graphHistory).present;
                setGraphHistory(step(graphHistory));
                setAdding(false);
                if (present.outputs[0]) {
                  if (!present.outputs.includes(selected))
                    setSelected(present.outputs[0]);
                  void show(present, present.outputs[0], true).catch(
                    () => undefined,
                  );
                } else {
                  setPreview(null);
                  setSelected("");
                }
              }}
            >
              {t(key)}
            </button>
          ))}
          <p className="page-meta">{t("outputHint")}</p>
          {record?.publishedVersion ? (
            <p className="help">{t("preparationAdoptionHint")}</p>
          ) : null}
        </aside>
        <div className="data-preparation-main">
          {stepFormTitle ? (
            <section
              ref={stepPanel}
              className="data-step-panel"
              aria-labelledby={stepPanelTitleId}
              tabIndex={-1}
            >
              <h3 id={stepPanelTitleId}>{t(stepFormTitle)}</h3>
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
                            [],
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
                  draft={
                    record
                      ? { id: record.id, version: record.version }
                      : undefined
                  }
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
                      [editing.node.id],
                      true,
                    );
                    setEditing(null);
                  }}
                />
              ) : null}
              {adding && preview ? (
                <StepForm
                  key={currentOutput}
                  workspaceId={workspaceId}
                  draft={
                    record
                      ? { id: record.id, version: record.version }
                      : undefined
                  }
                  input={currentOutput}
                  fields={fields}
                  graph={graph}
                  sources={sources.filter(
                    (s) =>
                      !record ||
                      !s.id.startsWith("prepared:" + record.id + ":"),
                  )}
                  busy={!!busy}
                  onCancel={() => {
                    setAdding(false);
                    void show(graph, currentOutput).catch(() => undefined);
                  }}
                  onApply={async (nodes) => {
                    const next = appendPreparation(graph, nodes, currentOutput);
                    await changeGraph(
                      next,
                      currentOutput,
                      next.nodes
                        .slice(graph.nodes.length)
                        .map((node) => node.id),
                      true,
                    );
                    setAdding(false);
                  }}
                />
              ) : null}
            </section>
          ) : null}
          <div className="data-preview-panel">
            <div className="data-preview-header">
              <div>
                <h3>{t("sample")}</h3>
                <p className="page-meta">{t("sampleHint")}</p>
              </div>
              <button
                type="button"
                disabled={
                  !!busy ||
                  inputMetadata.loading ||
                  !!inputMetadata.error ||
                  !selected
                }
                onClick={() =>
                  void show(graph, selected).catch(() => undefined)
                }
              >
                {t(busy === "preview" ? "previewing" : "preview")}
              </button>
            </div>
            {selectedNode ? (
              <div className="data-step-actions">
                <div className="data-form-actions">
                  <button
                    type="button"
                    disabled={
                      !!busy ||
                      inputMetadata.loading ||
                      !!inputMetadata.error ||
                      formOpen
                    }
                    ref={(button) => {
                      openers.current.editStep = button;
                    }}
                    onClick={() => void editSelected()}
                  >
                    {t("editStep")}
                  </button>
                  <button
                    type="button"
                    disabled={
                      !!busy ||
                      inputMetadata.loading ||
                      !!inputMetadata.error ||
                      formOpen ||
                      !!moveUp
                    }
                    title={moveUp ? t(`editErrors.${moveUp}`) : undefined}
                    onClick={() => void move("up")}
                  >
                    {t("moveStepUp")}
                  </button>
                  <button
                    type="button"
                    disabled={
                      !!busy ||
                      inputMetadata.loading ||
                      !!inputMetadata.error ||
                      formOpen ||
                      !!moveDown
                    }
                    title={moveDown ? t(`editErrors.${moveDown}`) : undefined}
                    onClick={() => void move("down")}
                  >
                    {t("moveStepDown")}
                  </button>
                  <button
                    type="button"
                    disabled={
                      !!busy ||
                      inputMetadata.loading ||
                      !!inputMetadata.error ||
                      formOpen ||
                      !!removal
                    }
                    ref={(button) => {
                      openers.current.removeStep = button;
                    }}
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
            <DataTable
              fields={fields}
              rows={preview?.rows ?? []}
              loading={busy === "preview"}
              focusColumn={
                graph.nodes.find((node) => node.id === selected)?.type ===
                "calculate"
                  ? (
                      graph.nodes.find(
                        (node) => node.id === selected,
                      ) as Extract<PreparationNode, { type: "calculate" }>
                    ).fieldId
                  : undefined
              }
            />
            {preview && previewStale ? (
              <p className="help" role="status">
                {t("sampleOutdated")}
              </p>
            ) : null}
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
          </div>
        </div>
      </div>
    </section>
  );
}
