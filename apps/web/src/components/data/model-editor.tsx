"use client";
import { useEffect, useId, useRef, useState } from "react";
import {
  formatDataFormula,
  parseDataFormula,
  type SemanticModelDefinition,
  type ModelMeasure,
  type DataField,
  type ModelDimension,
} from "@netrics/domain";
import {
  previewModelDefinition,
  saveModel,
  publishModel,
  restoreModel,
  type DataSource,
  type ModelDraft,
  type ModelResult,
} from "@/lib/data-api";
import { dataErrorKey, newDataId } from "@/lib/data-editing";
import { useT } from "@/lib/i18n/client";
import { AggregateFields, ColumnChecks, ColumnSelect } from "./fields";
import { DataTable } from "./data-table";
import { PreviewNotes } from "./preview-notes";
import { DefinitionHistory } from "./definition-history";
import { useDraftSources } from "@/lib/data-source-metadata";

const EMPTY: SemanticModelDefinition = {
  version: 1,
  datasets: [],
  relationships: [],
  dimensions: [],
  measures: [],
};
export function ModelEditor({
  workspaceId,
  sources: sourceCatalog,
  initial,
  onSaved,
  onClose,
  onDirty,
}: {
  workspaceId: string;
  sources: DataSource[];
  initial: ModelDraft | null;
  onSaved: (model: ModelDraft) => void;
  onClose: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const t = useT("data"),
    nameId = useId(),
    filterId = useId();
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
  const inputMetadata = useDraftSources(
    workspaceId,
    "models",
    record,
    sourceCatalog,
  );
  const sources = inputMetadata.sources;
  const [definition, setDefinition] = useState(initial?.definition ?? EMPTY);
  const [formulaTexts, setFormulaTexts] = useState<Record<string, string>>({});
  const [savedState, setSavedState] = useState(
    JSON.stringify({
      name: initial?.name ?? t("defaultModel"),
      definition: initial?.definition ?? EMPTY,
      formulaTexts: {},
    }),
  );
  const [measureIds, setMeasureIds] = useState(
    initial?.definition.measures.map((m) => m.id) ?? [],
  );
  const [groupBy, setGroupBy] = useState<string[]>([]),
    [filterText, setFilterText] = useState("");
  const [result, setResult] = useState<ModelResult | null>(null),
    [previewState, setPreviewState] = useState("");
  const [outputFields, setOutputFields] = useState<DataField[]>([]);
  const [busy, setBusy] = useState<
    "preview" | "save" | "publish" | "history" | null
  >(null);
  const [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const current = JSON.stringify({ name, definition, formulaTexts }),
    queryState = JSON.stringify({ measureIds, groupBy, filterText });
  const dirty = current !== savedState,
    fresh = previewState === current + queryState;
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  const selectedSources = sources.filter((s) =>
    definition.datasets.includes(s.id),
  );
  const fieldsFor = (id: string) =>
    sources.find((s) => s.id === id)?.fields ?? [];
  const change = (patch: Partial<SemanticModelDefinition>) => {
    setDefinition((d) => ({ ...d, ...patch }));
    setNotice(null);
  };
  function changeMeasure(id: string, next: ModelMeasure) {
    change({
      measures: definition.measures.map((m) => (m.id === id ? next : m)),
    });
  }
  function build() {
    return {
      ...definition,
      measures: definition.measures.map((m) =>
        m.kind === "formula" && formulaTexts[m.id] !== undefined
          ? {
              ...m,
              expression: parseDataFormula(
                formulaTexts[m.id]!,
                definition.measures,
              ),
            }
          : m,
      ),
    };
  }
  async function preview() {
    if (inputMetadata.loading || inputMetadata.error || !valid()) return;
    setBusy("preview");
    setError(null);
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
          groupBy,
          ...(filter ? { filter } : {}),
        },
        record ? { id: record.id, version: record.version } : undefined,
      );
      setResult(next);
      setOutputFields([
        ...groupBy.map((id): DataField => {
          const dimension = model.dimensions.find((d) => d.id === id)!;
          const source = fieldsFor(dimension.datasetId).find(
            (f) => f.id === dimension.fieldId,
          )!;
          return { ...source, id: "d." + id, name: dimension.name };
        }),
        ...measureIds.map((id): DataField => {
          const cell = next.rows[0]?.measures[id];
          return {
            id: "m." + id,
            name: model.measures.find((m) => m.id === id)!.name,
            type: cell?.type ?? "decimal",
            nullable: true,
            ...(cell?.unit ? { unit: cell.unit } : {}),
          };
        }),
      ]);
      setPreviewState(current + queryState);
    } catch (failure) {
      setError(t(`errors.${dataErrorKey(failure)}`));
      setResult(null);
    } finally {
      setBusy(null);
    }
  }
  async function persist(publish: boolean) {
    if (inputMetadata.loading || inputMetadata.error || !valid()) return;
    setBusy(publish ? "publish" : "save");
    setError(null);
    setNotice(null);
    try {
      const model = build();
      const saved =
        record &&
        !dirty &&
        (!publish || record.publishedVersion !== record.version)
          ? { model: record }
          : await saveModel(
              workspaceId,
              {
                name: name.trim(),
                definition: model,
                ...(record
                  ? {
                      version: record.version,
                      ...(publish &&
                      !record.restoredFromVersion &&
                      record.publishedVersion === record.version
                        ? { adoptLatestInputs: true }
                        : {}),
                    }
                  : {}),
              },
              record?.id,
            );
      setRecord(saved.model);
      setDefinition(model);
      setFormulaTexts({});
      const signature = JSON.stringify({
        name,
        definition: model,
        formulaTexts: {},
      });
      setSavedState(signature);
      if (fresh) setPreviewState(signature + queryState);
      onSaved(saved.model);
      if (publish) {
        const published = await publishModel(
          workspaceId,
          saved.model.id,
          saved.model.version,
        );
        setRecord(published.model);
        onSaved(published.model);
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
      setDefinition(next.definition);
      setFormulaTexts({});
      setSavedState(
        JSON.stringify({
          name: next.name,
          definition: next.definition,
          formulaTexts: {},
        }),
      );
      setMeasureIds(next.definition.measures.map((measure) => measure.id));
      setGroupBy([]);
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
    const datasetId = definition.datasets[0]!,
      id = newDataId();
    change({
      measures: [
        ...definition.measures,
        {
          id,
          name: t("measureName") + " " + (definition.measures.length + 1),
          kind: "aggregate",
          datasetId,
          aggregate: { id, name: t("count"), op: "count" },
        },
      ],
    });
    setMeasureIds((ids) => [...ids, id]);
  }
  const dimensionFields: DataField[] = definition.dimensions.map((d) => ({
    ...(fieldsFor(d.datasetId).find((f) => f.id === d.fieldId) ?? {
      type: "string",
      nullable: true,
    }),
    id: d.id,
    name: d.name,
  }));
  const measureFields: DataField[] = definition.measures.map((m) => ({
    id: m.id,
    name: m.name,
    type: "decimal",
    nullable: true,
  }));
  const rows =
    result?.rows.map((row) =>
      Object.fromEntries([
        ...Object.entries(row.dimensions).map(([id, value]) => [
          "d." + id,
          row.dimensionLabels?.[id] ?? value,
        ]),
        ...Object.entries(row.measures).map(([id, cell]) => [
          "m." + id,
          cell.value === null
            ? null
            : cell.currency
              ? String(cell.value) + " " + cell.currency
              : cell.value,
        ]),
      ]),
    ) ?? [];
  const sourceSelect = (
    label: string,
    value: string,
    onChange: (id: string) => void,
  ) => (
    <label className="field">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} required>
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
            const update = (patch: Partial<ModelDimension>) =>
              change({
                dimensions: definition.dimensions.map((d) =>
                  d.id === dimension.id ? { ...d, ...patch } : d,
                ),
              });
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
                    onChange={(e) => update({ name: e.target.value })}
                  />
                </label>
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
                )}
                <ColumnSelect
                  label={t("field")}
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
                    value={measure.name}
                    onChange={(e) =>
                      changeMeasure(measure.id, {
                        ...measure,
                        name: e.target.value,
                      })
                    }
                  />
                </label>
                <button
                  type="button"
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
              <div className="data-form-grid">
                <label className="field">
                  {t("measureKind")}
                  <select
                    value={measure.kind}
                    onChange={(e) => {
                      changeMeasure(
                        measure.id,
                        e.target.value === "aggregate"
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
                    <option value="formula">{t("formulaMeasure")}</option>
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
                        onChange={(event) =>
                          changeMeasure(measure.id, {
                            ...measure,
                            requiredDimensions: event.target.checked
                              ? [
                                  ...(measure.requiredDimensions ?? []),
                                  dimension.id,
                                ]
                              : (measure.requiredDimensions ?? []).filter(
                                  (id) => id !== dimension.id,
                                ),
                          })
                        }
                      />
                      {dimension.name}
                    </label>
                  ))}
                </fieldset>
              ) : null}
              {measure.kind === "aggregate" ? (
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
              ) : (
                <div className="field">
                  <label htmlFor={measure.id}>{t("formula")}</label>
                  <textarea
                    id={measure.id}
                    rows={2}
                    required
                    maxLength={10000}
                    value={
                      formulaTexts[measure.id] ??
                      formatDataFormula(measure.expression, definition.measures)
                    }
                    onChange={(e) =>
                      setFormulaTexts((texts) => ({
                        ...texts,
                        [measure.id]: e.target.value,
                      }))
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
              onChange={setMeasureIds}
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
        {result?.stale ? <p className="notice">{t("stale")}</p> : null}
        {result ? <PreviewNotes warnings={result.warnings} /> : null}
        {result ? (
          <DataTable
            fields={outputFields}
            rows={rows}
            loading={busy === "preview"}
          />
        ) : null}
      </section>
    </section>
  );
}
