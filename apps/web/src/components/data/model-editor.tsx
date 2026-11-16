"use client";
import {
  recordChange,
  redoEdit,
  replacePresent,
  startHistory,
  undoEdit,
  type EditHistory,
} from "@/lib/edit-history";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  canonicalJson,
  DataProcessingError,
  emptyVisualModel,
  formulaMeasureFields,
  missingModelMeasureScope,
  modelMeasureDateScope,
  modelMeasureScope,
  parseDataFormula,
  probeModelMeasures,
  type DataExpression,
  type SemanticModelDefinition,
  type ModelMeasure,
  type DataField,
  type ModelDimension,
} from "@netrics/domain";
import {
  previewModelDefinition,
  saveModel,
  publishModel,
  readDataImpact,
  restoreModel,
  type DataSource,
  type ModelDraft,
  type ModelResult,
} from "@/lib/data-api";
import { dataErrorKey, newDataId } from "@/lib/data-editing";
import { useT } from "@/lib/i18n/client";
import {
  AggregateFields,
  ColumnChecks,
  ColumnSelect,
  WindowedMeasureFields,
} from "./fields";
import {
  changeMeasureSiblings,
  isWindowedMeasure,
  keepModelSelection,
  previewFailureKey,
  measureDependents,
  rollingBaseOf,
  timeDimensionCandidates,
  toWindowedMeasure,
  windowBaseCandidates,
  withMeasureScope,
} from "@/lib/model-measures";
import {
  ModelPreviewTable,
  type ModelPreviewQuery,
} from "./model-preview-table";
import { ApiError } from "@/lib/api";
import { PreviewNotes } from "./preview-notes";
import { FilterValueNotes } from "./filter-value-notes";
import { DefinitionHistory } from "./definition-history";
import {
  publishAfterConfirmation,
  useImpactConfirmation,
  type ImpactCheck,
} from "./publish-impact-dialog";
import { useDraftSources } from "@/lib/data-source-metadata";
import {
  resolveExpressionDraft,
  type ExpressionDraft,
} from "@/lib/expression-draft";
import { ExpressionEditor } from "./expression-editor";

/**
 * What undo and redo restore: the definition and the expression drafts not
 * yet resolved into it, keyed `${measureId}:formula` (a calculated measure)
 * and `${measureId}:filter` (an aggregate's filter).
 */
interface ModelEdit {
  definition: SemanticModelDefinition;
  expressionDrafts: Record<string, ExpressionDraft>;
}

/**
 * The editor's state as compared for unsaved changes. Only edited drafts
 * count: switching views without typing is no change, and neither is key
 * order.
 */
export function modelEditorState(
  name: string,
  definition: SemanticModelDefinition,
  drafts: Record<string, ExpressionDraft>,
): string {
  return canonicalJson({
    name,
    definition,
    drafts: Object.fromEntries(
      Object.entries(drafts)
        .filter(([, draft]) => draft.edited)
        .map(([key, draft]) => [key, comparableDraft(draft)]),
    ),
  });
}

/** Formula text switched from rows and not typed in is still those rows. */
function comparableDraft(draft: ExpressionDraft): ExpressionDraft {
  return draft.view === "formula" &&
    draft.origin &&
    draft.text === draft.origin.text
    ? { view: "visual", model: draft.origin.model, edited: draft.edited }
    : draft;
}

/**
 * Applies a definition patch as one undo step (coalesced by `editKey`),
 * dropping drafts it orphans. A patch that changes nothing records nothing.
 */
export function changeModelDefinition(
  history: EditHistory<ModelEdit>,
  patch: Partial<SemanticModelDefinition>,
  editKey?: string,
): EditHistory<ModelEdit> {
  const definition = { ...history.present.definition, ...patch };
  return recordChange(
    history,
    {
      definition,
      expressionDrafts: liveDrafts(
        definition,
        history.present.expressionDrafts,
      ),
    },
    editKey,
  );
}

/** Drafts of measures that no longer exist or no longer have that kind are dropped. */
function liveDrafts(
  definition: SemanticModelDefinition,
  drafts: Record<string, ExpressionDraft>,
): Record<string, ExpressionDraft> {
  const kinds = new Map(definition.measures.map((m) => [m.id, m.kind]));
  return Object.fromEntries(
    Object.entries(drafts).filter(([key]) => {
      const at = key.lastIndexOf(":");
      const kind = kinds.get(key.slice(0, at)),
        part = key.slice(at + 1);
      return part === "formula" ? kind === "formula" : kind === "aggregate";
    }),
  );
}

const EMPTY: SemanticModelDefinition = {
  version: 1,
  datasets: [],
  relationships: [],
  dimensions: [],
  measures: [],
};
/**
 * The model's impact for the publish confirmation, plus the widgets that
 * read a measure whose draft differs from the live release (asked per
 * measure, at most 50 at a time). Measures only in the release cannot be
 * asked about; a failed follow-up only drops the "changed" markers.
 */
export async function modelImpact(
  workspaceId: string,
  id: string,
  definition: SemanticModelDefinition,
  read: typeof readDataImpact = readDataImpact,
): Promise<ImpactCheck> {
  const impact = await read(workspaceId, { kind: "model", id });
  const changed = (impact.changedMeasureIds ?? []).filter((measure) =>
    definition.measures.some((m) => m.id === measure),
  );
  const changedWidgetIds: string[] = [];
  try {
    for (let start = 0; start < changed.length; start += 50) {
      const narrowed = await read(workspaceId, {
        kind: "model",
        id,
        measureIds: changed.slice(start, start + 50),
      });
      for (const dashboard of narrowed.dashboards)
        for (const widget of dashboard.widgets)
          changedWidgetIds.push(widget.id);
    }
  } catch {
    return { impact };
  }
  return { impact, changedWidgetIds };
}

/**
 * A new measure: a count with an empty name, which the name field's
 * placeholder explains. A prefilled name had to be deleted first (#631).
 */
export function newAggregateMeasure(
  id: string,
  datasetId: string,
  /** The aggregate's own name, which the API requires to be non-empty. */
  aggregateName: string,
): Extract<ModelMeasure, { kind: "aggregate" }> {
  return {
    id,
    name: "",
    kind: "aggregate",
    datasetId,
    aggregate: { id, name: aggregateName, op: "count" },
  };
}
/**
 * Renames a measure. An aggregate's own name follows, as the aggregate
 * fields already make it, so a measure named only after its aggregate was
 * edited never keeps an empty aggregate name.
 */
export function renameMeasure(
  measure: ModelMeasure,
  name: string,
): ModelMeasure {
  return measure.kind === "aggregate"
    ? { ...measure, name, aggregate: { ...measure.aggregate, name } }
    : { ...measure, name };
}
/**
 * How pickers name each measure: its name, or "Unnamed measure 1", "…2" in
 * order for measures not named yet, so two of them stay apart.
 */
export function measureLabels(
  measures: readonly ModelMeasure[],
  unnamed: (number: number) => string,
): Map<string, string> {
  let count = 0;
  return new Map(
    measures.map((m) => [m.id, m.name.trim() || unnamed(++count)]),
  );
}
export function ModelEditor({
  workspaceId,
  sources: sourceCatalog,
  initial,
  projectId = null,
  onSaved,
  onClose,
  onDirty,
}: {
  workspaceId: string;
  sources: DataSource[];
  initial: ModelDraft | null;
  /** The project a new model starts in (#573). */
  projectId?: string | null;
  onSaved: (model: ModelDraft) => void;
  onClose: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const t = useT("data"),
    nameId = useId(),
    filterId = useId(),
    scopeHintId = useId();
  const fieldsRef = useRef<HTMLFieldSetElement>(null);
  const valid = () => {
    const input = fieldsRef.current?.querySelector<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >("input:invalid,select:invalid,textarea:invalid");
    if (input) {
      input.reportValidity();
      return false;
    }
    return true;
  };
  const [record, setRecord] = useState(initial),
    [name, setName] = useState(initial?.name ?? t("defaultModel"));
  const confirmation = useImpactConfirmation(name.trim() || t("defaultModel"));
  const inputMetadata = useDraftSources(
    workspaceId,
    "models",
    record,
    sourceCatalog,
  );
  const sources = inputMetadata.sources;
  // Undo/redo covers the definition and the expression drafts. The name,
  // preview selection and filter stay outside it.
  const [edits, setEdits] = useState(() =>
    startHistory<ModelEdit>({
      definition: initial?.definition ?? EMPTY,
      expressionDrafts: {},
    }),
  );
  const { definition, expressionDrafts } = edits.present;
  const [savedState, setSavedState] = useState(() =>
    modelEditorState(
      initial?.name ?? t("defaultModel"),
      initial?.definition ?? EMPTY,
      {},
    ),
  );
  const [measureIds, setMeasureIds] = useState(
    initial?.definition.measures.map((m) => m.id) ?? [],
  );
  // Scoped measures (e.g. per store) preview grouped by their scope.
  const [groupBy, setGroupBy] = useState<string[]>(() =>
      initial
        ? withMeasureScope(
            initial.definition,
            initial.definition.measures.map((m) => m.id),
            [],
          )
        : [],
    ),
    [filterText, setFilterText] = useState("");
  const [result, setResult] = useState<ModelResult | null>(null),
    [previewState, setPreviewState] = useState("");
  // The draft and query the shown preview ran with.
  const [previewed, setPreviewed] = useState<ModelPreviewQuery | null>(null);
  // The measure just added, whose empty name field takes the focus.
  const [addedMeasureId, setAddedMeasureId] = useState<string | null>(null);
  const [busy, setBusy] = useState<
    "preview" | "save" | "publish" | "history" | null
  >(null);
  const [error, setError] = useState<string | null>(null),
    // Shown beside the Preview button, which sits far below the page header.
    [previewError, setPreviewError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  // The expression whose draft failed to save, to mark its rows.
  const [expressionProblem, setExpressionProblem] = useState<{
    key: string;
    code: string;
    fieldId?: string;
  } | null>(null);
  const current = useMemo(
      () => modelEditorState(name, definition, expressionDrafts),
      [name, definition, expressionDrafts],
    ),
    queryState = canonicalJson({ measureIds, groupBy, filterText });
  const dirty = current !== savedState,
    fresh = previewState === current + queryState;
  // The required dimensions the chosen preview neither groups by nor filters
  // to one value: the server refuses such a preview (and so publishing).
  const missingScope = useMemo(() => {
    let filter: DataExpression | undefined;
    try {
      filter = filterText.trim()
        ? parseDataFormula(filterText, definition.dimensions)
        : undefined;
    } catch {
      filter = undefined;
    }
    return missingModelMeasureScope(definition, {
      measureIds,
      groupBy,
      ...(filter ? { filter } : {}),
    });
  }, [definition, measureIds, groupBy, filterText]);
  const scopeHintShown = missingScope.length > 0 && measureIds.length > 0;
  const dateScope = modelMeasureDateScope(definition, measureIds);
  const dimensionName = (id: string) =>
    definition.dimensions.find((d) => d.id === id)?.name ?? id;
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  const selectedSources = sources.filter((s) =>
    definition.datasets.includes(s.id),
  );
  const fieldsFor = (id: string) =>
    sources.find((s) => s.id === id)?.fields ?? [];
  // The measures each calculated measure may use, typed by the checker.
  // One probe of the model per definition; each formula's fields derive from it.
  const formulaFields = useMemo(() => {
    const sourceMap = new Map(sources.map((s) => [s.id, s]));
    const probed = probeModelMeasures(definition, sourceMap);
    return new Map(
      definition.measures
        .filter((m) => m.kind === "formula")
        .map((m) => [
          m.id,
          formulaMeasureFields(definition, sourceMap, m.id, probed),
        ]),
    );
  }, [definition, sources]);
  /** `editKey` coalesces consecutive edits of one text field into one undo step. */
  const change = (
    patch: Partial<SemanticModelDefinition>,
    editKey?: string,
  ) => {
    setEdits((h) => changeModelDefinition(h, patch, editKey));
    setNotice(null);
  };
  /**
   * Keeps an expression draft. Views switched without edits replace the
   * present (no undo step, no change); an unchanged draft records nothing.
   */
  function changeDraft(key: string, draft: ExpressionDraft) {
    setEdits((h) => {
      const next = {
        ...h.present,
        expressionDrafts: { ...h.present.expressionDrafts, [key]: draft },
      };
      return draft.edited
        ? recordChange(h, next, `draft:${key}`)
        : replacePresent(h, next);
    });
    setExpressionProblem(null);
    setNotice(null);
  }
  /** Sets or removes an aggregate's filter, with its draft, as one edit. */
  function changeMeasureFilter(
    measure: ModelMeasure,
    draft: ExpressionDraft | null,
  ) {
    const key = `${measure.id}:filter`;
    setEdits((h) => {
      const { [key]: _removed, ...drafts } = h.present.expressionDrafts;
      return recordChange(h, {
        definition: draft
          ? h.present.definition
          : {
              ...h.present.definition,
              measures: h.present.definition.measures.map((m) => {
                if (m.id !== measure.id || m.kind !== "aggregate") return m;
                const { filter: _filter, ...aggregate } = m.aggregate;
                return { ...m, aggregate };
              }),
            },
        expressionDrafts: draft ? { ...drafts, [key]: draft } : drafts,
      });
    });
    setExpressionProblem(null);
    setNotice(null);
  }
  function changeMeasure(id: string, next: ModelMeasure, editKey?: string) {
    change(
      {
        measures: definition.measures.map((m) => (m.id === id ? next : m)),
      },
      editKey,
    );
  }
  function stepHistory(step: typeof undoEdit) {
    const next = step(edits);
    setEdits(next);
    const kept = keepModelSelection(
      next.present.definition,
      measureIds,
      groupBy,
    );
    setMeasureIds(kept.measureIds);
    setGroupBy(kept.groupBy);
    setNotice(null);
    setError(null);
    setPreviewError(null);
  }
  /**
   * The definition with every draft resolved. Unedited drafts keep the stored
   * expression object, so saving without edits changes nothing.
   */
  function build(): SemanticModelDefinition {
    const resolve = (
      key: string,
      initial: DataExpression | undefined,
      target: "condition" | "calculation",
      fields: readonly DataField[],
    ) => {
      try {
        return resolveExpressionDraft(
          expressionDrafts[key],
          initial,
          target,
          fields,
        );
      } catch (failure) {
        if (failure instanceof DataProcessingError)
          setExpressionProblem({
            key,
            code: failure.code,
            ...(failure.fieldId ? { fieldId: failure.fieldId } : {}),
          });
        throw failure;
      }
    };
    return {
      ...definition,
      measures: definition.measures.map((m) => {
        if (m.kind === "formula" && expressionDrafts[`${m.id}:formula`]) {
          const expression = resolve(
            `${m.id}:formula`,
            m.expression,
            "calculation",
            formulaFields.get(m.id) ?? [],
          );
          return expression === m.expression ? m : { ...m, expression };
        }
        if (m.kind === "aggregate" && expressionDrafts[`${m.id}:filter`]) {
          const filter = resolve(
            `${m.id}:filter`,
            m.aggregate.filter,
            "condition",
            fieldsFor(m.datasetId),
          );
          return filter === m.aggregate.filter
            ? m
            : { ...m, aggregate: { ...m.aggregate, filter } };
        }
        return m;
      }),
    };
  }
  /** `grouping` previews with another grouping, which the editor then shows. */
  async function preview(grouping = groupBy) {
    if (inputMetadata.loading || inputMetadata.error || !valid()) return;
    const ranWith = canonicalJson({
      measureIds,
      groupBy: grouping,
      filterText,
    });
    setBusy("preview");
    setError(null);
    setPreviewError(null);
    setNotice(null);
    try {
      const model = build();
      const filter = filterText.trim()
        ? parseDataFormula(filterText, model.dimensions)
        : undefined;
      const next = await previewModelDefinition(
        workspaceId,
        model,
        {
          measureIds,
          groupBy: grouping,
          ...(filter ? { filter } : {}),
        },
        record ? { id: record.id, version: record.version } : undefined,
      );
      setResult(next);
      setPreviewed({ model, measureIds, groupBy: grouping });
      setPreviewState(current + ranWith);
    } catch (failure) {
      // A missing scope is explained, with its fix, by the scope hint while
      // it is shown for the grouping the preview ran with.
      const key = previewFailureKey(
        dataErrorKey(failure),
        scopeHintShown && grouping === groupBy,
      );
      // A display name of several values says how many, and of what.
      const shared =
        failure instanceof ApiError &&
        failure.code === "model_filter_label_several_values" &&
        failure.details.count &&
        failure.details.fieldId
          ? t("errors.labelSeveralCount", {
              count: failure.details.count,
              dimension: dimensionName(failure.details.fieldId),
            })
          : null;
      setPreviewError(shared ?? (key ? t(`errors.${key}`) : null));
      setResult(null);
    } finally {
      setBusy(null);
    }
  }
  async function persist(publish: boolean) {
    if (inputMetadata.loading || inputMetadata.error || !valid()) return;
    setBusy(publish ? "publish" : "save");
    setError(null);
    setPreviewError(null);
    setNotice(null);
    try {
      const model = build();
      let saved = false;
      const save = async () => {
        const result =
          record &&
          !dirty &&
          (!publish || record.publishedVersion !== record.version)
            ? { model: record }
            : await saveModel(
                workspaceId,
                {
                  name: name.trim(),
                  definition: model,
                  ...(record ? { version: record.version } : { projectId }),
                },
                record?.id,
              );
        saved = result.model !== record;
        setRecord(result.model);
        setEdits((h) =>
          replacePresent(h, { definition: model, expressionDrafts: {} }),
        );
        const signature = modelEditorState(name, model, {});
        setSavedState(signature);
        if (fresh) setPreviewState(signature + queryState);
        onSaved(result.model);
        return result.model;
      };
      if (!publish) {
        await save();
        setNotice(t("saved"));
        return;
      }
      const outcome = await publishAfterConfirmation({
        existed: !!record,
        save,
        confirm: (draft) =>
          confirmation.ask(() =>
            modelImpact(workspaceId, draft.id, draft.definition),
          ),
        publish: async (draft) => {
          const published = await publishModel(
            workspaceId,
            draft.id,
            draft.version,
          );
          setRecord(published.model);
          onSaved(published.model);
        },
      });
      if (outcome === "published") setNotice(t("publishedNotice"));
      else if (saved) setNotice(t("saved"));
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
    setPreviewError(null);
    setNotice(null);
    try {
      const saved =
        version === undefined
          ? await saveModel(
              workspaceId,
              {
                name,
                definition,
                version: record.version,
                adoptLatestInputs: true,
              },
              record.id,
            )
          : await restoreModel(workspaceId, record.id, record.version, version);
      const next = saved.model;
      setRecord(next);
      setName(next.name);
      setEdits(
        startHistory({ definition: next.definition, expressionDrafts: {} }),
      );
      setExpressionProblem(null);
      setSavedState(modelEditorState(next.name, next.definition, {}));
      const ids = next.definition.measures.map((measure) => measure.id);
      setMeasureIds(ids);
      setGroupBy(withMeasureScope(next.definition, ids, []));
      setFilterText("");
      setResult(null);
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
  function addMeasure() {
    const id = newDataId();
    change({
      measures: [
        ...definition.measures,
        newAggregateMeasure(id, definition.datasets[0]!, t("count")),
      ],
    });
    setMeasureIds((ids) => [...ids, id]);
    setGroupBy((current) => withMeasureScope(definition, [id], current));
    setAddedMeasureId(id);
  }
  const timeDimensions = timeDimensionCandidates(definition, fieldsFor);
  const dependents = (id: string) => measureDependents(definition, id);
  function addChangeMeasures(
    measure: Extract<ModelMeasure, { kind: "period_offset" }>,
  ) {
    const added = changeMeasureSiblings(
      definition,
      measure,
      {
        change: t("changeMeasureName", { name: measure.name }),
        percent_change: t("percentChangeMeasureName", { name: measure.name }),
      },
      newDataId,
    );
    const at = definition.measures.findIndex((m) => m.id === measure.id) + 1;
    const measures = [
      ...definition.measures.slice(0, at),
      ...added,
      ...definition.measures.slice(at),
    ];
    change({ measures });
    setMeasureIds((ids) => [...ids, ...added.map((m) => m.id)]);
    setGroupBy((current) =>
      withMeasureScope(
        { ...definition, measures },
        added.map((m) => m.id),
        current,
      ),
    );
  }
  const dimensionFields: DataField[] = definition.dimensions.map((d) => ({
    ...(fieldsFor(d.datasetId).find((f) => f.id === d.fieldId) ?? {
      type: "string",
      nullable: true,
    }),
    id: d.id,
    name: d.name,
  }));
  const labels = measureLabels(definition.measures, (number) =>
    t("unnamedMeasure", { number }),
  );
  const measureFields: DataField[] = definition.measures.map((m) => ({
    id: m.id,
    name: labels.get(m.id)!,
    type: "decimal",
    nullable: true,
  }));
  const sourceSelect = (
    label: string,
    value: string,
    onChange: (id: string) => void,
    blockedBy?: string,
  ) => (
    <label className="field">
      {label}
      <select
        aria-describedby={blockedBy}
        disabled={!!blockedBy}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
      >
        <option value="">{t("choose")}</option>
        {selectedSources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <section className="data-editor" aria-labelledby="model-title">
      {confirmation.dialog}
      <header className="data-editor-header">
        <div>
          <button type="button" className="link-button" onClick={onClose}>
            {t("back")}
          </button>
          <h2 id="model-title">{name || t("defaultModel")}</h2>
          <p className="page-meta">
            {record?.publishedVersion
              ? t("published", { version: record.publishedVersion })
              : t("unpublished")}
            {dirty ? " · " + t("changed") : ""}
          </p>
        </div>
        <div className="data-form-actions">
          {(
            [
              ["undo", undoEdit, edits.past.length],
              ["redo", redoEdit, edits.future.length],
            ] as const
          ).map(([key, step, available]) => (
            <button
              key={key}
              type="button"
              disabled={
                !available ||
                !!busy ||
                inputMetadata.loading ||
                !!inputMetadata.error
              }
              onClick={() => stepHistory(step)}
            >
              {t(key)}
            </button>
          ))}
          <button
            type="button"
            disabled={
              !!busy ||
              inputMetadata.loading ||
              !!inputMetadata.error ||
              !name.trim() ||
              !definition.measures.length ||
              (!!record && !dirty)
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
              !fresh ||
              !!error ||
              !name.trim() ||
              (!!record?.restoredFromVersion &&
                record.publishedVersion === record.version &&
                !dirty)
            }
            onClick={() => void persist(true)}
          >
            {t(
              busy === "publish"
                ? "publishing"
                : !dirty &&
                    record &&
                    !record.restoredFromVersion &&
                    record.publishedVersion === record.version
                  ? "republish"
                  : "publish",
            )}
          </button>
        </div>
      </header>
      <p className="data-intro">{t("modelHint")}</p>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="notice">
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
          kind="models"
          id={record.id}
          publishedVersion={record.publishedVersion}
          restoredFromVersion={record.restoredFromVersion}
          disabled={!!busy}
          unsaved={dirty}
          onRestore={restore}
          onAdoptLatest={() => restore()}
        />
      ) : null}
      <fieldset
        ref={fieldsRef}
        disabled={!!busy || inputMetadata.loading || !!inputMetadata.error}
        className="data-editor-fields"
      >
        <div className="field data-name-field">
          <label htmlFor={nameId}>{t("modelName")}</label>
          <input
            id={nameId}
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <section className="data-model-section">
          <h3>{t("datasets")}</h3>
          <div className="data-source-checks">
            {sources.map((source) => {
              const used =
                definition.relationships.some(
                  (r) =>
                    r.from.datasetId === source.id ||
                    r.to.datasetId === source.id,
                ) ||
                definition.dimensions.some((d) => d.datasetId === source.id) ||
                definition.measures.some(
                  (m) => m.kind === "aggregate" && m.datasetId === source.id,
                );
              return (
                <label className="check" key={source.id}>
                  <input
                    type="checkbox"
                    checked={definition.datasets.includes(source.id)}
                    disabled={used}
                    onChange={(e) =>
                      change({
                        datasets: e.target.checked
                          ? [...definition.datasets, source.id]
                          : definition.datasets.filter(
                              (id) => id !== source.id,
                            ),
                      })
                    }
                  />
                  {source.name}
                </label>
              );
            })}
          </div>
        </section>
        <section className="data-model-section">
          <div className="data-section-heading">
            <h3>{t("relationships")}</h3>
            <button
              type="button"
              disabled={selectedSources.length < 2}
              onClick={() =>
                change({
                  relationships: [
                    ...definition.relationships,
                    {
                      id: newDataId(),
                      from: { datasetId: selectedSources[0]!.id, fieldId: "" },
                      to: { datasetId: selectedSources[1]!.id, fieldId: "" },
                      cardinality: "many_to_one",
                    },
                  ],
                })
              }
            >
              {t("addRelationship")}
            </button>
          </div>
          {definition.relationships.map((relationship) => (
            <div className="data-model-row" key={relationship.id}>
              {sourceSelect(
                t("factDataset"),
                relationship.from.datasetId,
                (datasetId) =>
                  change({
                    relationships: definition.relationships.map((r) =>
                      r.id === relationship.id
                        ? { ...r, from: { datasetId, fieldId: "" } }
                        : r,
                    ),
                  }),
              )}
              <ColumnSelect
                label={t("leftKey")}
                fields={fieldsFor(relationship.from.datasetId).filter(
                  (f) => f.type !== "json",
                )}
                value={relationship.from.fieldId}
                onChange={(fieldId) =>
                  change({
                    relationships: definition.relationships.map((r) =>
                      r.id === relationship.id
                        ? { ...r, from: { ...r.from, fieldId } }
                        : r,
                    ),
                  })
                }
              />
              {sourceSelect(
                t("dimensionDataset"),
                relationship.to.datasetId,
                (datasetId) =>
                  change({
                    relationships: definition.relationships.map((r) =>
                      r.id === relationship.id
                        ? { ...r, to: { datasetId, fieldId: "" } }
                        : r,
                    ),
                  }),
              )}
              <ColumnSelect
                label={t("rightKey")}
                fields={fieldsFor(relationship.to.datasetId).filter((f) => {
                  const left = fieldsFor(relationship.from.datasetId).find(
                    (v) => v.id === relationship.from.fieldId,
                  );
                  return f.type !== "json" && (!left || f.type === left.type);
                })}
                value={relationship.to.fieldId}
                onChange={(fieldId) =>
                  change({
                    relationships: definition.relationships.map((r) =>
                      r.id === relationship.id
                        ? { ...r, to: { ...r.to, fieldId } }
                        : r,
                    ),
                  })
                }
              />
              <label className="field">
                {t("cardinality")}
                <select
                  value={relationship.cardinality}
                  onChange={(e) =>
                    change({
                      relationships: definition.relationships.map((r) =>
                        r.id === relationship.id
                          ? {
                              ...r,
                              cardinality: e.target
                                .value as typeof r.cardinality,
                            }
                          : r,
                      ),
                    })
                  }
                >
                  <option value="many_to_one">{t("manyToOne")}</option>
                  <option value="one_to_one">{t("oneToOne")}</option>
                </select>
              </label>
              <button
                type="button"
                onClick={() =>
                  change({
                    relationships: definition.relationships.filter(
                      (r) => r.id !== relationship.id,
                    ),
                  })
                }
              >
                {t("remove")}
              </button>
            </div>
          ))}
        </section>
        <section className="data-model-section">
          <div className="data-section-heading">
            <h3>{t("dimensions")}</h3>
            <button
              type="button"
              disabled={!selectedSources.length}
              onClick={() =>
                change({
                  dimensions: [
                    ...definition.dimensions,
                    {
                      id: newDataId(),
                      name:
                        t("dimensionName") +
                        " " +
                        (definition.dimensions.length + 1),
                      datasetId: selectedSources[0]!.id,
                      fieldId: "",
                      labelFieldId: undefined,
                    },
                  ],
                })
              }
            >
              {t("addDimension")}
            </button>
          </div>
          {!definition.dimensions.length ? (
            <p className="page-meta">{t("noDimensions")}</p>
          ) : null}
          {definition.dimensions.map((dimension) => {
            const update = (patch: Partial<ModelDimension>, editKey?: string) =>
              change(
                {
                  dimensions: definition.dimensions.map((d) =>
                    d.id === dimension.id ? { ...d, ...patch } : d,
                  ),
                },
                editKey,
              );
            const anchoring = definition.measures.filter(
              (m) => isWindowedMeasure(m) && m.timeDimensionId === dimension.id,
            );
            return (
              <div
                className="data-model-row data-model-row--dimension"
                key={dimension.id}
              >
                <label className="field">
                  {t("dimensionName")}
                  <input
                    maxLength={100}
                    required
                    value={dimension.name}
                    onChange={(e) =>
                      update(
                        { name: e.target.value },
                        `dimension:${dimension.id}:name`,
                      )
                    }
                  />
                </label>
                {/* A window's anchor keeps its date column: another source
                    or column could change its type or alignment. */}
                {sourceSelect(
                  t("sourceName"),
                  dimension.datasetId,
                  (datasetId) =>
                    update({
                      datasetId,
                      fieldId: "",
                      labelFieldId: undefined,
                      timeAlignment: undefined,
                    }),
                  anchoring.length ? dimension.id + "-in-use" : undefined,
                )}
                <ColumnSelect
                  label={t("field")}
                  disabled={anchoring.length > 0}
                  describedBy={
                    anchoring.length ? dimension.id + "-in-use" : undefined
                  }
                  fields={fieldsFor(dimension.datasetId).filter(
                    (f) => f.type !== "json",
                  )}
                  value={dimension.fieldId}
                  onChange={(fieldId) => {
                    const type = fieldsFor(dimension.datasetId).find(
                      (f) => f.id === fieldId,
                    )?.type;
                    update({
                      fieldId,
                      timeAlignment:
                        type === "date"
                          ? "reporting_date"
                          : type === "timestamp"
                            ? "instant"
                            : undefined,
                    });
                  }}
                />
                <label className="field">
                  {t("dimensionLabel")}
                  <select
                    value={dimension.labelFieldId ?? ""}
                    onChange={(event) =>
                      update({ labelFieldId: event.target.value || undefined })
                    }
                  >
                    <option value="">{t("dimensionLabelNone")}</option>
                    {fieldsFor(dimension.datasetId)
                      .filter((field) => field.type === "string")
                      .map((field) => (
                        <option key={field.id} value={field.id}>
                          {field.name}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={anchoring.length > 0}
                  aria-describedby={
                    anchoring.length ? dimension.id + "-in-use" : undefined
                  }
                  onClick={() => {
                    change({
                      dimensions: definition.dimensions.filter(
                        (d) => d.id !== dimension.id,
                      ),
                      measures: definition.measures.map((measure) => ({
                        ...measure,
                        requiredDimensions: measure.requiredDimensions?.filter(
                          (id) => id !== dimension.id,
                        ),
                      })),
                    });
                    setGroupBy((ids) =>
                      ids.filter((id) => id !== dimension.id),
                    );
                  }}
                >
                  {t("remove")}
                </button>
                {anchoring.length ? (
                  <p className="help" id={dimension.id + "-in-use"}>
                    {t("dimensionInUse", {
                      names: anchoring.map((m) => m.name).join(", "),
                    })}
                  </p>
                ) : null}
              </div>
            );
          })}
        </section>
        <section className="data-model-section">
          <div className="data-section-heading">
            <h3>{t("measures")}</h3>
            <button
              type="button"
              disabled={!selectedSources.length}
              onClick={addMeasure}
            >
              {t("addMeasure")}
            </button>
          </div>
          {definition.measures.map((measure) => (
            <div className="data-measure" key={measure.id}>
              <div className="data-section-heading">
                <label className="field">
                  {t("measureName")}
                  <input
                    required
                    maxLength={100}
                    placeholder={t("measureNamePlaceholder")}
                    autoFocus={measure.id === addedMeasureId}
                    value={measure.name}
                    onChange={(e) =>
                      changeMeasure(
                        measure.id,
                        renameMeasure(measure, e.target.value),
                        `measure:${measure.id}:name`,
                      )
                    }
                  />
                </label>
                <button
                  type="button"
                  disabled={dependents(measure.id).length > 0}
                  aria-describedby={
                    dependents(measure.id).length
                      ? measure.id + "-in-use"
                      : undefined
                  }
                  onClick={() => {
                    change({
                      measures: definition.measures.filter(
                        (m) => m.id !== measure.id,
                      ),
                    });
                    setMeasureIds((ids) =>
                      ids.filter((id) => id !== measure.id),
                    );
                  }}
                >
                  {t("remove")}
                </button>
              </div>
              {dependents(measure.id).length ? (
                <p className="help" id={measure.id + "-in-use"}>
                  {t("measureInUse", {
                    names: dependents(measure.id)
                      .map((m) => m.name)
                      .join(", "),
                  })}
                </p>
              ) : null}
              <div className="data-form-grid">
                <label className="field">
                  {t("measureKind")}
                  <select
                    aria-describedby={
                      dependents(measure.id).length
                        ? measure.id + "-in-use"
                        : undefined
                    }
                    value={measure.kind}
                    onChange={(e) => {
                      const kind = e.target.value;
                      changeMeasure(
                        measure.id,
                        kind === "rolling" || kind === "period_offset"
                          ? toWindowedMeasure(
                              measure,
                              kind,
                              definition,
                              fieldsFor,
                            )
                          : kind === "aggregate"
                            ? {
                                id: measure.id,
                                name: measure.name,
                                requiredDimensions: measure.requiredDimensions,
                                kind: "aggregate",
                                datasetId: definition.datasets[0]!,
                                aggregate: {
                                  id: measure.id,
                                  name: measure.name,
                                  op: "count",
                                },
                              }
                            : {
                                id: measure.id,
                                name: measure.name,
                                requiredDimensions: measure.requiredDimensions,
                                kind: "formula",
                                expression: {
                                  kind: "literal",
                                  type: "integer",
                                  value: 0,
                                },
                              },
                      );
                    }}
                  >
                    <option value="aggregate">{t("aggregateMeasure")}</option>
                    {/* Rolling re-aggregates its base's rows. */}
                    {(
                      [
                        ["formula", "formulaMeasure"],
                        ["rolling", "rollingMeasure"],
                        ["period_offset", "offsetMeasure"],
                      ] as const
                    ).map(([kind, label]) => (
                      <option
                        key={kind}
                        value={kind}
                        disabled={
                          measure.kind === "aggregate" &&
                          rollingBaseOf(definition, measure.id).length > 0
                        }
                      >
                        {t(label)}
                      </option>
                    ))}
                  </select>
                </label>
                {measure.kind === "aggregate"
                  ? sourceSelect(
                      t("sourceName"),
                      measure.datasetId,
                      (datasetId) =>
                        changeMeasure(measure.id, {
                          ...measure,
                          datasetId,
                          aggregate: {
                            ...measure.aggregate,
                            fieldId: undefined,
                            orderBy: undefined,
                          },
                        }),
                    )
                  : null}
              </div>
              {definition.dimensions.length ? (
                <fieldset className="stack">
                  <legend>{t("requiredScope")}</legend>
                  <p className="help">{t("requiredScopeHelp")}</p>
                  {definition.dimensions.map((dimension) => (
                    <label className="checkbox-row" key={dimension.id}>
                      <input
                        type="checkbox"
                        checked={
                          measure.requiredDimensions?.includes(dimension.id) ??
                          false
                        }
                        onChange={(event) => {
                          const next: ModelMeasure = {
                            ...measure,
                            requiredDimensions: event.target.checked
                              ? [
                                  ...(measure.requiredDimensions ?? []),
                                  dimension.id,
                                ]
                              : (measure.requiredDimensions ?? []).filter(
                                  (id) => id !== dimension.id,
                                ),
                          };
                          changeMeasure(measure.id, next);
                          // Required now: the preview groups by it too.
                          if (
                            event.target.checked &&
                            modelMeasureScope(
                              {
                                ...definition,
                                measures: definition.measures.map((m) =>
                                  m.id === measure.id ? next : m,
                                ),
                              },
                              measureIds,
                            ).includes(dimension.id)
                          )
                            setGroupBy((ids) =>
                              ids.includes(dimension.id)
                                ? ids
                                : [...ids, dimension.id],
                            );
                        }}
                      />
                      {dimension.name}
                    </label>
                  ))}
                </fieldset>
              ) : null}
              {measure.kind === "aggregate" ? (
                <>
                  <AggregateFields
                    showName={false}
                    fields={fieldsFor(measure.datasetId)}
                    value={{ ...measure.aggregate, name: measure.name }}
                    onChange={(aggregate) =>
                      changeMeasure(measure.id, {
                        ...measure,
                        name: aggregate.name,
                        aggregate,
                      })
                    }
                  />
                  {measure.aggregate.filter !== undefined ||
                  expressionDrafts[`${measure.id}:filter`] ? (
                    <>
                      <ExpressionEditor
                        label={t("measureFilter")}
                        target="condition"
                        fields={fieldsFor(measure.datasetId)}
                        initial={measure.aggregate.filter}
                        draft={expressionDrafts[`${measure.id}:filter`]}
                        onDraftChange={(draft) =>
                          changeDraft(`${measure.id}:filter`, draft)
                        }
                        problem={
                          expressionProblem?.key === `${measure.id}:filter`
                            ? expressionProblem
                            : undefined
                        }
                      />
                      <div className="data-form-actions">
                        <button
                          type="button"
                          onClick={() => changeMeasureFilter(measure, null)}
                        >
                          {t("removeMeasureFilter")}
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="data-form-actions">
                      <button
                        type="button"
                        onClick={() =>
                          changeMeasureFilter(measure, {
                            view: "visual",
                            model: emptyVisualModel("condition"),
                            edited: true,
                          })
                        }
                      >
                        {t("addMeasureFilter")}
                      </button>
                    </div>
                  )}
                </>
              ) : isWindowedMeasure(measure) ? (
                <>
                  <WindowedMeasureFields
                    measure={measure}
                    baseMeasures={windowBaseCandidates(definition, measure).map(
                      (m) => ({ ...m, name: labels.get(m.id) ?? m.name }),
                    )}
                    timeDimensions={timeDimensions}
                    onChange={(next) => changeMeasure(measure.id, next)}
                  />
                  {measure.kind === "period_offset" ? (
                    <div className="data-form-actions">
                      <button
                        type="button"
                        disabled={
                          !changeMeasureSiblings(
                            definition,
                            measure,
                            { change: "", percent_change: "" },
                            () => "",
                          ).length
                        }
                        onClick={() => addChangeMeasures(measure)}
                      >
                        {t("addChangeMeasures")}
                      </button>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="field">
                  <ExpressionEditor
                    label={t("formula")}
                    target="calculation"
                    noun="measure"
                    fields={formulaFields.get(measure.id) ?? []}
                    initial={measure.expression}
                    draft={expressionDrafts[`${measure.id}:formula`]}
                    onDraftChange={(draft) =>
                      changeDraft(`${measure.id}:formula`, draft)
                    }
                    problem={
                      expressionProblem?.key === `${measure.id}:formula`
                        ? expressionProblem
                        : undefined
                    }
                  />
                  <p className="help">{t("measureFormulaHelp")}</p>
                </div>
              )}
            </div>
          ))}
        </section>
      </fieldset>
      <section
        className="data-model-preview"
        aria-labelledby="model-preview-title"
      >
        <div className="data-section-heading">
          <div>
            <h3 id="model-preview-title">{t("preview")}</h3>
            <p className="page-meta">
              {t(
                !result
                  ? "previewInitial"
                  : fresh
                    ? "freshPreview"
                    : "previewOutdated",
              )}
            </p>
          </div>
          <button
            type="button"
            className="primary"
            disabled={
              !!busy ||
              inputMetadata.loading ||
              !!inputMetadata.error ||
              !measureIds.length
            }
            aria-describedby={scopeHintShown ? scopeHintId : undefined}
            onClick={() => void preview()}
          >
            {t(busy === "preview" ? "previewing" : "preview")}
          </button>
        </div>
        {!definition.measures.length ? (
          <p>{t("noMeasures")}</p>
        ) : (
          <div className="data-form-grid">
            <ColumnChecks
              label={t("queryMeasures")}
              fields={measureFields}
              value={measureIds}
              onChange={(ids) => {
                const added = ids.filter((id) => !measureIds.includes(id));
                setMeasureIds(ids);
                setGroupBy((current) =>
                  withMeasureScope(definition, added, current),
                );
              }}
            />
            <ColumnChecks
              label={t("groupBy")}
              fields={dimensionFields}
              value={groupBy}
              onChange={setGroupBy}
            />
          </div>
        )}
        <div className="field">
          <label htmlFor={filterId}>{t("sharedFilter")}</label>
          <textarea
            id={filterId}
            rows={2}
            maxLength={10000}
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            aria-describedby={filterId + "-help"}
          />
          <p className="help" id={filterId + "-help"}>
            {t("sharedFilterHelp")}
          </p>
        </div>
        {scopeHintShown ? (
          <PreviewScopeHint
            id={scopeHintId}
            dimensions={missingScope
              .filter((id) => !dateScope.includes(id))
              .map(dimensionName)}
            dates={missingScope
              .filter((id) => dateScope.includes(id))
              .map(dimensionName)}
            disabled={!!busy || inputMetadata.loading || !!inputMetadata.error}
            onFix={() => {
              const next = [...groupBy, ...missingScope];
              setGroupBy(next);
              void preview(next);
            }}
          />
        ) : null}
        {previewError ? (
          <p role="alert" className="error">
            {previewError}
          </p>
        ) : null}
        {result?.stale ? <p className="notice">{t("stale")}</p> : null}
        {result ? (
          <PreviewNotes
            warnings={result.warnings.filter(
              (warning) =>
                !(
                  warning === "model_filter_value_unknown" &&
                  result.filterValueNotes?.length
                ),
            )}
          />
        ) : null}
        {result ? (
          <FilterValueNotes
            notes={result.filterValueNotes}
            dimensionName={dimensionName}
          />
        ) : null}
        {result && previewed ? (
          <ModelPreviewTable
            query={previewed}
            result={result}
            sources={sources}
            loading={busy === "preview"}
          />
        ) : null}
      </section>
    </section>
  );
}

/**
 * Beside the preview: the chosen grouping leaves out dimensions the measures
 * keep separate (`dimensions`) or the date a window is computed per
 * (`dates`), so it cannot preview or publish. One click groups by them all
 * and previews. `id` describes the Preview button.
 */
export function PreviewScopeHint({
  id,
  dimensions,
  dates,
  disabled = false,
  onFix,
}: {
  id: string;
  dimensions: string[];
  dates: string[];
  disabled?: boolean;
  onFix: () => void;
}) {
  const t = useT("data");
  return (
    <div className="notice data-preview-scope" role="status" id={id}>
      {dimensions.length ? (
        <p>{t("previewScope", { dimensions: dimensions.join(", ") })}</p>
      ) : null}
      {dates.length ? (
        <p>{t("previewScopeDate", { dimensions: dates.join(", ") })}</p>
      ) : null}
      <button type="button" disabled={disabled} onClick={onFix}>
        {t("previewScopeFix", {
          dimensions: [...dimensions, ...dates].join(", "),
        })}
      </button>
    </div>
  );
}
