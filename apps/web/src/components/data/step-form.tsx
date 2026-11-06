"use client";
import { useEffect, useId, useState } from "react";
import {
  DATA_TYPES,
  DataProcessingError,
  parseDataFormula,
  formatDataFormula,
  type DataField,
  type PreparationNode,
  type PreparationGraph,
  type AggregateDefinition,
  type DataType,
} from "@netrics/domain";
import type { DataSource } from "@/lib/data-api";
import { previewData, previewPreparation } from "@/lib/data-api";
import {
  dataErrorKey,
  enteredValue,
  newDataId,
  preparationAt,
} from "@/lib/data-editing";
import {
  preparationInputNodes,
  suggestAppendColumnMapping,
  buildAppendStep,
} from "@/lib/preparation-editing";
import { useT } from "@/lib/i18n/client";
import { AggregateFields, ColumnChecks, ColumnSelect } from "./fields";

const operations = [
  "select",
  "rename",
  "cast",
  "replace",
  "filter",
  "calculate",
  "deduplicate",
  "append",
  "join",
  "group",
] as const;
export function StepForm({
  workspaceId,
  input,
  fields,
  sources,
  busy,
  graph,
  initial,
  draft,
  onApply,
  onCancel,
}: {
  workspaceId: string;
  input: string;
  fields: DataField[];
  sources: DataSource[];
  busy: boolean;
  graph?: PreparationGraph;
  initial?: PreparationNode;
  draft?: { id: string; version: number };
  onApply: (nodes: PreparationNode[]) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT("data"),
    opId = useId(),
    nameId = useId(),
    formulaId = useId(),
    otherId = useId();
  const [operation, setOperation] = useState<
    (typeof operations)[number] | "source"
  >(initial?.type ?? "calculate");
  const [fieldId, setFieldId] = useState(
    initial && "fieldId" in initial ? initial.fieldId : (fields[0]?.id ?? ""),
  );
  const [keys, setKeys] = useState(
    initial?.type === "select"
      ? initial.fields
      : initial && "keys" in initial && initial.type !== "join"
        ? initial.keys
        : fields.map((f) => f.id),
  );
  const [renames, setRenames] = useState<
    Array<{ fieldId: string; name: string }>
  >(() =>
    initial?.type === "rename"
      ? Object.entries(initial.names).map(([fieldId, name]) => ({
          fieldId,
          name,
        }))
      : [{ fieldId: fields[0]?.id ?? "", name: "" }],
  );
  const [name, setName] = useState(
    initial?.type === "calculate" ? initial.name : "",
  );
  const initialFormula =
    initial && "expression" in initial
      ? formatDataFormula(initial.expression, fields)
      : "";
  const [formula, setFormula] = useState(initialFormula);
  const [toType, setToType] = useState<DataType>(
    initial?.type === "cast" ? initial.to : "decimal",
  );
  const [onError, setOnError] = useState<"reject" | "null">(
    initial?.type === "cast" ? initial.onError : "reject",
  );
  const valueText = (value: unknown) =>
    value === null
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  const [from, setFrom] = useState(
    initial?.type === "replace" ? valueText(initial.from) : "",
  );
  const [to, setTo] = useState(
    initial?.type === "replace" ? valueText(initial.to) : "",
  );
  const [fromNull, setFromNull] = useState(
      initial?.type === "replace" && initial.from === null,
    ),
    [toNull, setToNull] = useState(
      initial?.type === "replace" && initial.to === null,
    );
  const [keep, setKeep] = useState<"first" | "last">(
    initial?.type === "deduplicate" ? initial.keep : "first",
  );
  const [sourceId, setSourceId] = useState(
    initial?.type === "source" ? initial.datasetId : "",
  );
  const [other, setOther] = useState(
    initial?.type === "join" ? "step:" + initial.right : "",
  );
  const [otherFields, setOtherFields] = useState<DataField[]>([]);
  const [joinKeys, setJoinKeys] = useState(
    initial?.type === "join"
      ? initial.keys
      : [{ left: fields[0]?.id ?? "", right: "" }],
  );
  const [appendInputs, setAppendInputs] = useState(
    initial?.type === "append"
      ? initial.inputs.map((id) => "step:" + id)
      : ["step:" + input, ""],
  );
  const [matchColumns, setMatchColumns] = useState(
    initial?.type === "append" && !!initial.columnMappings,
  );
  const [appendSchemas, setAppendSchemas] = useState<
    Record<string, DataField[]>
  >({});
  const [appendTargets, setAppendTargets] = useState<DataField[]>(fields);
  const [appendMappings, setAppendMappings] = useState<
    Record<string, Record<string, string>>
  >(() =>
    Object.fromEntries(
      initial?.type === "append"
        ? Object.entries(initial.columnMappings ?? {}).map(
            ([nodeId, mapping]) => ["step:" + nodeId, mapping],
          )
        : [],
    ),
  );
  const [loadingAppend, setLoadingAppend] = useState(false);
  const [mode, setMode] = useState<"left" | "inner">(
    initial?.type === "join" ? initial.mode : "left",
  );
  const [cardinality, setCardinality] = useState<"many_to_one" | "one_to_one">(
    initial?.type === "join" ? initial.cardinality : "many_to_one",
  );
  const [namePrefix, setNamePrefix] = useState(
    initial?.type === "join" ? (initial.rightNamePrefix ?? "") : "",
  );
  const [aggregates, setAggregates] = useState<AggregateDefinition[]>(
    initial?.type === "group"
      ? initial.aggregates
      : [{ id: newDataId(), name: t("count"), op: "count" }],
  );
  const [aggregateFilters, setAggregateFilters] = useState<
    Record<string, string>
  >(() =>
    Object.fromEntries(
      (initial?.type === "group" ? initial.aggregates : []).map((aggregate) => [
        aggregate.id,
        aggregate.filter ? formatDataFormula(aggregate.filter, fields) : "",
      ]),
    ),
  );
  const [error, setError] = useState<string | null>(null),
    [loadingOther, setLoadingOther] = useState(false);
  const inputNodes = graph
    ? preparationInputNodes(graph, initial?.id ?? "")
    : [];
  const nodeName = (node: PreparationNode) =>
    node.type === "source"
      ? (sources.find((source) => source.id === node.datasetId)?.name ??
        node.datasetId)
      : node.type === "calculate"
        ? node.name
        : t(node.type);
  useEffect(() => {
    let alive = true;
    setOtherFields([]);
    setLoadingOther(false);
    if (!other || operation !== "join") return;
    setLoadingOther(true);
    const result =
      other.startsWith("step:") && graph
        ? previewPreparation(
            workspaceId,
            preparationAt(graph, other.slice(5)),
            draft,
          ).then((preview) => preview.outputs[other.slice(5)]!)
        : previewData(workspaceId, other.slice(8), draft);
    result
      .then((value) => {
        if (alive) {
          setOtherFields(value.fields);
          setJoinKeys((current) =>
            current.map((pair) => ({
              ...pair,
              right: pair.right || value.fields[0]?.id || "",
            })),
          );
        }
      })
      .catch((failure: unknown) => {
        if (alive) setError(t(`errors.${dataErrorKey(failure)}`));
      })
      .finally(() => {
        if (alive) setLoadingOther(false);
      });
    return () => {
      alive = false;
    };
  }, [workspaceId, other, operation, graph, t, draft?.id, draft?.version]);
  const appendKey = JSON.stringify(appendInputs);
  useEffect(() => {
    let alive = true;
    setLoadingAppend(false);
    if (operation !== "append" || !matchColumns) return;
    const choices = JSON.parse(appendKey) as string[];
    setLoadingAppend(true);
    const load = async () => {
      const loaded: Record<string, DataField[]> = {};
      for (let offset = 0; offset < choices.length && alive; offset += 4) {
        await Promise.all(
          choices
            .slice(offset, offset + 4)
            .filter(Boolean)
            .map(async (choice) => {
              const value =
                choice.startsWith("step:") && graph
                  ? (
                      await previewPreparation(
                        workspaceId,
                        preparationAt(graph, choice.slice(5)),
                        draft,
                      )
                    ).outputs[choice.slice(5)]!
                  : await previewData(workspaceId, choice.slice(8), draft);
              loaded[choice] = value.fields;
            }),
        );
      }
      if (!alive) return;
      setAppendSchemas(loaded);
      setAppendTargets((current) => {
        if (current.length) return current;
        const first = choices[0],
          source = first ? (loaded[first] ?? []) : [];
        const mapping =
          initial?.type === "append" && first?.startsWith("step:")
            ? initial.columnMappings?.[first.slice(5)]
            : undefined;
        return mapping
          ? source.flatMap((field) =>
              mapping[field.id] ? [{ ...field, id: mapping[field.id]! }] : [],
            )
          : source;
      });
    };
    void load()
      .catch((failure: unknown) => {
        if (alive) setError(t(`errors.${dataErrorKey(failure)}`));
      })
      .finally(() => {
        if (alive) setLoadingAppend(false);
      });
    return () => {
      alive = false;
    };
  }, [
    operation,
    matchColumns,
    appendKey,
    workspaceId,
    graph,
    initial,
    t,
    draft?.id,
    draft?.version,
  ]);
  function mappingFor(choice: string): Record<string, string> {
    if (Object.hasOwn(appendMappings, choice)) return appendMappings[choice]!;
    const source = appendSchemas[choice] ?? [];
    // Existing inputs without a mapping keep append-by-ID semantics. Reopening
    // a partly mapped append must not infer new name joins for those inputs.
    if (
      initial?.type === "append" &&
      choice.startsWith("step:") &&
      initial.inputs.includes(choice.slice(5))
    )
      return Object.fromEntries(source.map((field) => [field.id, field.id]));
    return suggestAppendColumnMapping(appendTargets, source);
  }
  function inputOptions() {
    return (
      <>
        <option value="">{t("choose")}</option>
        {inputNodes.map((node, index) => (
          <option key={"step:" + node.id} value={"step:" + node.id}>
            {t("stepInput", { number: index + 1, name: nodeName(node) })}
          </option>
        ))}
        {sources.map((source) => (
          <option key={"dataset:" + source.id} value={"dataset:" + source.id}>
            {t("datasetInput", { name: source.name })}
          </option>
        ))}
      </>
    );
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const id = initial?.id ?? newDataId();
      const added: PreparationNode[] = [];
      const resolveInput = (choice: string) => {
        if (
          choice.startsWith("step:") &&
          inputNodes.some((node) => node.id === choice.slice(5))
        )
          return choice.slice(5);
        if (
          !choice.startsWith("dataset:") ||
          !sources.some((source) => source.id === choice.slice(8))
        )
          throw new DataProcessingError("preparation_input_invalid");
        const source: PreparationNode = {
          id: newDataId(),
          type: "source",
          datasetId: choice.slice(8),
        };
        added.push(source);
        return source.id;
      };
      let node: PreparationNode;
      if (operation === "source")
        node = { id, type: "source", datasetId: sourceId };
      else if (operation === "select")
        node = { id, type: "select", input, fields: keys };
      else if (operation === "rename") {
        if (
          new Set(renames.map((rename) => rename.fieldId)).size !==
          renames.length
        )
          throw new DataProcessingError("preparation_rename_invalid");
        node = {
          id,
          type: "rename",
          input,
          names: Object.fromEntries(
            renames.map(({ fieldId, name }) => [fieldId, name.trim()]),
          ),
        };
      } else if (operation === "cast")
        node = { id, type: "cast", input, fieldId, to: toType, onError };
      else if (operation === "replace") {
        const field = fields.find((field) => field.id === fieldId)!;
        node = {
          id,
          type: "replace",
          input,
          fieldId,
          from: fromNull ? null : enteredValue(field.type, from, false),
          to: toNull ? null : enteredValue(field.type, to, false),
        };
      } else if (operation === "filter" || operation === "calculate") {
        const expression =
          initial && "expression" in initial && formula === initialFormula
            ? initial.expression
            : parseDataFormula(formula, fields);
        node =
          operation === "filter"
            ? { id, type: "filter", input, expression }
            : {
                id,
                type: "calculate",
                input,
                fieldId:
                  initial?.type === "calculate" ? initial.fieldId : newDataId(),
                name: name.trim(),
                expression,
              };
      } else if (operation === "deduplicate")
        node = { id, type: "deduplicate", input, keys, keep };
      else if (operation === "group")
        node = {
          id,
          type: "group",
          input,
          keys,
          aggregates: aggregates.map((aggregate) => {
            const text = aggregateFilters[aggregate.id] ?? "";
            const original =
              initial?.type === "group"
                ? initial.aggregates.find((item) => item.id === aggregate.id)
                : undefined;
            const originalText = original?.filter
              ? formatDataFormula(original.filter, fields)
              : "";
            return {
              ...aggregate,
              filter:
                text === originalText
                  ? original?.filter
                  : text.trim()
                    ? parseDataFormula(text, fields)
                    : undefined,
            };
          }),
        };
      else if (operation === "append") {
        node = buildAppendStep(
          id,
          appendInputs.map((choice) => ({
            id: resolveInput(choice),
            ...(matchColumns ? { mapping: mappingFor(choice) } : {}),
          })),
        );
      } else
        node = {
          id,
          type: "join",
          left: input,
          right: resolveInput(other),
          keys: joinKeys,
          mode,
          cardinality,
          rightPrefix:
            initial?.type === "join" ? initial.rightPrefix : newDataId() + ".",
          ...(namePrefix ? { rightNamePrefix: namePrefix } : {}),
        };
      await onApply([...added, node]);
    } catch (failure) {
      setError(t(`errors.${dataErrorKey(failure)}`));
    }
  }
  return (
    <form className="data-step-form" onSubmit={(e) => void submit(e)}>
      <fieldset disabled={busy} className="data-editor-fields">
        <div className="field">
          <label htmlFor={opId}>{t("operation")}</label>
          <select
            id={opId}
            value={operation}
            disabled={!!initial}
            onChange={(e) => {
              setOperation(e.target.value as typeof operation);
              setKeys(
                e.target.value === "group" ? [] : fields.map((f) => f.id),
              );
              setError(null);
            }}
          >
            {(initial?.type === "source"
              ? ["source" as const]
              : operations
            ).map((op) => (
              <option key={op} value={op}>
                {t(op)}
              </option>
            ))}
          </select>
        </div>
        {["select", "deduplicate", "group"].includes(operation) ? (
          <ColumnChecks
            label={t(
              operation === "select"
                ? "columns"
                : operation === "group"
                  ? "groupKeys"
                  : "keys",
            )}
            fields={fields}
            value={keys}
            onChange={setKeys}
          />
        ) : null}
        {operation === "source" ? (
          <label className="field">
            {t("sourceName")}
            <select
              required
              value={sourceId}
              onChange={(event) => setSourceId(event.target.value)}
            >
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {["cast", "replace"].includes(operation) ? (
          <ColumnSelect
            label={t("field")}
            fields={fields}
            value={fieldId}
            onChange={setFieldId}
          />
        ) : null}
        {operation === "rename" ? (
          <div className="data-aggregations">
            {renames.map((rename, index) => (
              <div className="data-aggregation" key={index}>
                <ColumnSelect
                  label={t("field")}
                  fields={fields}
                  value={rename.fieldId}
                  onChange={(fieldId) =>
                    setRenames((list) =>
                      list.map((item, at) =>
                        at === index ? { ...item, fieldId } : item,
                      ),
                    )
                  }
                />
                <label className="field">
                  {t("newName")}
                  <input
                    required
                    maxLength={100}
                    value={rename.name}
                    onChange={(event) =>
                      setRenames((list) =>
                        list.map((item, at) =>
                          at === index
                            ? { ...item, name: event.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                </label>
                {renames.length > 1 ? (
                  <button
                    type="button"
                    onClick={() =>
                      setRenames((list) => list.filter((_, at) => at !== index))
                    }
                  >
                    {t("remove")}
                  </button>
                ) : null}
              </div>
            ))}
            <button
              type="button"
              disabled={renames.length >= fields.length}
              onClick={() =>
                setRenames((list) => [
                  ...list,
                  {
                    fieldId:
                      fields.find(
                        (field) =>
                          !list.some((item) => item.fieldId === field.id),
                      )?.id ?? "",
                    name: "",
                  },
                ])
              }
            >
              {t("addRename")}
            </button>
          </div>
        ) : null}
        {operation === "calculate" ? (
          <div className="field">
            <label htmlFor={nameId}>{t("newName")}</label>
            <input
              id={nameId}
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        ) : null}
        {operation === "filter" || operation === "calculate" ? (
          <div className="field">
            <label htmlFor={formulaId}>{t("formula")}</label>
            <textarea
              id={formulaId}
              value={formula}
              onChange={(e) => setFormula(e.target.value)}
              required
              rows={3}
              maxLength={10000}
              placeholder={t("formulaPlaceholder")}
              aria-describedby={formulaId + "-help"}
            />
            <p id={formulaId + "-help"} className="help">
              {t("formulaHelp")}
            </p>
            <div
              className="data-reference-buttons"
              aria-label={t("insertColumn")}
            >
              {fields.map((f) => (
                <button
                  type="button"
                  key={f.id}
                  onClick={() =>
                    setFormula(
                      (value) =>
                        value +
                        formatDataFormula(
                          { kind: "field", fieldId: f.id },
                          fields,
                        ),
                    )
                  }
                >
                  {f.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {operation === "cast" ? (
          <div className="data-form-grid">
            <label className="field">
              {t("type")}
              <select
                value={toType}
                onChange={(e) => setToType(e.target.value as DataType)}
              >
                {DATA_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`types.${type}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              {t("onError")}
              <select
                value={onError}
                onChange={(e) => setOnError(e.target.value as typeof onError)}
              >
                <option value="reject">{t("reject")}</option>
                <option value="null">{t("useNull")}</option>
              </select>
            </label>
          </div>
        ) : null}
        {operation === "replace" ? (
          <div className="data-form-grid">
            {(["from", "to"] as const).map((side) => (
              <div className="field" key={side}>
                <label>
                  {t(side)}
                  <input
                    value={side === "from" ? from : to}
                    disabled={side === "from" ? fromNull : toNull}
                    onChange={(e) =>
                      side === "from"
                        ? setFrom(e.target.value)
                        : setTo(e.target.value)
                    }
                  />
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={side === "from" ? fromNull : toNull}
                    onChange={(e) =>
                      side === "from"
                        ? setFromNull(e.target.checked)
                        : setToNull(e.target.checked)
                    }
                  />
                  {t("nullValue")}
                </label>
              </div>
            ))}
          </div>
        ) : null}
        {operation === "deduplicate" ? (
          <label className="field">
            {t("keep")}
            <select
              value={keep}
              onChange={(e) => setKeep(e.target.value as typeof keep)}
            >
              <option value="first">{t("first")}</option>
              <option value="last">{t("last")}</option>
            </select>
          </label>
        ) : null}
        {operation === "append" ? (
          <div className="data-aggregations">
            {appendInputs.map((choice, index) => (
              <div className="data-aggregation" key={index}>
                <label className="field">
                  {t("appendInput", { number: index + 1 })}
                  <select
                    required
                    value={choice}
                    onChange={(event) =>
                      setAppendInputs((list) =>
                        list.map((item, at) =>
                          at === index ? event.target.value : item,
                        ),
                      )
                    }
                  >
                    {inputOptions()}
                  </select>
                </label>
                {appendInputs.length > 2 ? (
                  <button
                    type="button"
                    onClick={() =>
                      setAppendInputs((list) =>
                        list.filter((_, at) => at !== index),
                      )
                    }
                  >
                    {t("remove")}
                  </button>
                ) : null}
              </div>
            ))}
            <label className="check">
              <input
                type="checkbox"
                checked={matchColumns}
                onChange={(event) => setMatchColumns(event.target.checked)}
              />
              {t("matchAppendColumns")}
            </label>
            <p className="help">{t("appendMatchHint")}</p>
            {matchColumns ? (
              <div>
                {loadingAppend ? <p role="status">{t("loading")}</p> : null}
                {appendInputs.map((choice, index) => {
                  const source = appendSchemas[choice] ?? [],
                    mapping = mappingFor(choice);
                  return choice ? (
                    <fieldset
                      className="data-editor-fields"
                      key={index}
                      disabled={loadingAppend}
                    >
                      <legend>{t("appendInput", { number: index + 1 })}</legend>
                      {appendTargets.map((target) => {
                        const selected =
                          Object.entries(mapping).find(
                            ([, targetId]) => targetId === target.id,
                          )?.[0] ?? "";
                        return (
                          <label className="field" key={target.id}>
                            {target.name}
                            <select
                              value={selected}
                              onChange={(event) => {
                                const next = Object.fromEntries(
                                  Object.entries(mapping).filter(
                                    ([, targetId]) => targetId !== target.id,
                                  ),
                                );
                                if (event.target.value)
                                  next[event.target.value] = target.id;
                                setAppendMappings((current) => ({
                                  ...current,
                                  [choice]: next,
                                }));
                              }}
                            >
                              <option value="">{t("noMatchingColumn")}</option>
                              {source
                                .filter(
                                  (field) =>
                                    field.type === target.type ||
                                    field.id === selected,
                                )
                                .map((field) => (
                                  <option
                                    key={field.id}
                                    value={field.id}
                                    disabled={
                                      !!mapping[field.id] &&
                                      mapping[field.id] !== target.id
                                    }
                                  >
                                    {field.name}
                                  </option>
                                ))}
                            </select>
                          </label>
                        );
                      })}
                    </fieldset>
                  ) : null;
                })}
              </div>
            ) : null}
            <button
              type="button"
              disabled={appendInputs.length >= 20}
              onClick={() => setAppendInputs((list) => [...list, ""])}
            >
              {t("addInput")}
            </button>
          </div>
        ) : null}
        {operation === "join" ? (
          <>
            <label className="field" htmlFor={otherId}>
              {t("otherDataset")}
              <select
                id={otherId}
                required
                value={other}
                onChange={(event) => {
                  setOther(event.target.value);
                  setJoinKeys((current) =>
                    current.map((pair) => ({ ...pair, right: "" })),
                  );
                }}
              >
                {inputOptions()}
              </select>
            </label>
            <div className="data-aggregations">
              {joinKeys.map((pair, index) => (
                <div className="data-aggregation" key={index}>
                  <ColumnSelect
                    label={t("leftKey")}
                    fields={fields.filter((field) => field.type !== "json")}
                    value={pair.left}
                    onChange={(left) =>
                      setJoinKeys((list) =>
                        list.map((item, at) =>
                          at === index ? { ...item, left } : item,
                        ),
                      )
                    }
                  />
                  <ColumnSelect
                    label={t("rightKey")}
                    fields={otherFields.filter((field) => {
                      const left = fields.find(
                        (field) => field.id === pair.left,
                      );
                      return (
                        field.type !== "json" &&
                        (!left || field.type === left.type)
                      );
                    })}
                    value={pair.right}
                    onChange={(right) =>
                      setJoinKeys((list) =>
                        list.map((item, at) =>
                          at === index ? { ...item, right } : item,
                        ),
                      )
                    }
                    disabled={loadingOther}
                  />
                  {joinKeys.length > 1 ? (
                    <button
                      type="button"
                      onClick={() =>
                        setJoinKeys((list) =>
                          list.filter((_, at) => at !== index),
                        )
                      }
                    >
                      {t("remove")}
                    </button>
                  ) : null}
                </div>
              ))}
              <button
                type="button"
                disabled={joinKeys.length >= 10}
                onClick={() =>
                  setJoinKeys((list) => [...list, { left: "", right: "" }])
                }
              >
                {t("addJoinKey")}
              </button>
            </div>
            <label className="field">
              {t("mergedNamePrefix")}
              <input
                maxLength={100}
                value={namePrefix}
                onChange={(event) => setNamePrefix(event.target.value)}
              />
            </label>
            <div className="data-form-grid">
              <label className="field">
                {t("joinMode")}
                <select
                  value={mode}
                  onChange={(e) => setMode(e.target.value as typeof mode)}
                >
                  <option value="left">{t("leftJoin")}</option>
                  <option value="inner">{t("innerJoin")}</option>
                </select>
              </label>
              <label className="field">
                {t("cardinality")}
                <select
                  value={cardinality}
                  onChange={(e) =>
                    setCardinality(e.target.value as typeof cardinality)
                  }
                >
                  <option value="many_to_one">{t("manyToOne")}</option>
                  <option value="one_to_one">{t("oneToOne")}</option>
                </select>
              </label>
            </div>
            <p className="page-meta">{t("joinHint")}</p>
          </>
        ) : null}
        {operation === "group" ? (
          <div className="data-aggregations">
            {aggregates.map((aggregate, index) => (
              <div className="data-aggregation" key={aggregate.id}>
                <AggregateFields
                  fields={fields}
                  value={aggregate}
                  onChange={(next) =>
                    setAggregates((list) =>
                      list.map((a) => (a.id === aggregate.id ? next : a)),
                    )
                  }
                />
                <label className="field">
                  {t("aggregateFilter")}
                  <textarea
                    rows={2}
                    maxLength={10000}
                    value={aggregateFilters[aggregate.id] ?? ""}
                    onChange={(event) =>
                      setAggregateFilters((current) => ({
                        ...current,
                        [aggregate.id]: event.target.value,
                      }))
                    }
                    placeholder={t("formulaPlaceholder")}
                  />
                </label>
                {index ? (
                  <button
                    type="button"
                    onClick={() =>
                      setAggregates((list) =>
                        list.filter((a) => a.id !== aggregate.id),
                      )
                    }
                  >
                    {t("remove")}
                  </button>
                ) : null}
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                setAggregates((list) => [
                  ...list,
                  { id: newDataId(), name: t("count"), op: "count" },
                ])
              }
            >
              {t("addAggregate")}
            </button>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
        <div className="data-form-actions">
          <button
            type="submit"
            className="primary"
            disabled={
              busy ||
              loadingOther ||
              (operation === "append" && matchColumns && loadingAppend)
            }
          >
            {t(
              busy ? "previewing" : initial ? "applyStepChanges" : "applyStep",
            )}
          </button>
          <button type="button" onClick={onCancel} disabled={busy}>
            {t("cancel")}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
