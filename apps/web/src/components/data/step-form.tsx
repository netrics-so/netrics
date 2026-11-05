"use client";
import { useEffect, useId, useState } from "react";
import {
  DATA_TYPES,
  parseDataFormula,
  formatDataFormula,
  type DataField,
  type PreparationNode,
  type AggregateDefinition,
  type DataType,
} from "@netrics/domain";
import type { DataSource } from "@/lib/data-api";
import { previewData } from "@/lib/data-api";
import { dataErrorKey, enteredValue, newDataId } from "@/lib/data-editing";
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
  onApply,
  onCancel,
}: {
  workspaceId: string;
  input: string;
  fields: DataField[];
  sources: DataSource[];
  busy: boolean;
  onApply: (nodes: PreparationNode[]) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT("data"),
    opId = useId(),
    nameId = useId(),
    formulaId = useId(),
    otherId = useId();
  const [operation, setOperation] =
    useState<(typeof operations)[number]>("calculate");
  const [fieldId, setFieldId] = useState(fields[0]?.id ?? "");
  const [keys, setKeys] = useState(fields.map((f) => f.id));
  const [name, setName] = useState("");
  const [formula, setFormula] = useState("");
  const [toType, setToType] = useState<DataType>("decimal");
  const [onError, setOnError] = useState<"reject" | "null">("reject");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [fromNull, setFromNull] = useState(false),
    [toNull, setToNull] = useState(false);
  const [keep, setKeep] = useState<"first" | "last">("first");
  const [other, setOther] = useState("");
  const [otherFields, setOtherFields] = useState<DataField[]>([]);
  const [rightKey, setRightKey] = useState("");
  const [mode, setMode] = useState<"left" | "inner">("left");
  const [cardinality, setCardinality] = useState<"many_to_one" | "one_to_one">(
    "many_to_one",
  );
  const [aggregates, setAggregates] = useState<AggregateDefinition[]>([
    { id: newDataId(), name: t("count"), op: "count" },
  ]);
  const [error, setError] = useState<string | null>(null),
    [loadingOther, setLoadingOther] = useState(false);
  useEffect(() => {
    let alive = true;
    setOtherFields([]);
    setRightKey("");
    if (!other) return;
    setLoadingOther(true);
    previewData(workspaceId, other)
      .then((value) => {
        if (alive) {
          setOtherFields(value.fields);
          setRightKey(value.fields[0]?.id ?? "");
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
  }, [workspaceId, other, t]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const id = newDataId();
      let nodes: PreparationNode[];
      if (operation === "select")
        nodes = [{ id, type: "select", input, fields: keys }];
      else if (operation === "rename")
        nodes = [
          { id, type: "rename", input, names: { [fieldId]: name.trim() } },
        ];
      else if (operation === "cast")
        nodes = [{ id, type: "cast", input, fieldId, to: toType, onError }];
      else if (operation === "replace") {
        const field = fields.find((f) => f.id === fieldId)!;
        nodes = [
          {
            id,
            type: "replace",
            input,
            fieldId,
            from: fromNull ? null : enteredValue(field.type, from, false),
            to: toNull ? null : enteredValue(field.type, to, false),
          },
        ];
      } else if (operation === "filter" || operation === "calculate") {
        const expression = parseDataFormula(formula, fields);
        nodes =
          operation === "filter"
            ? [{ id, type: "filter", input, expression }]
            : [
                {
                  id,
                  type: "calculate",
                  input,
                  fieldId: newDataId(),
                  name: name.trim(),
                  expression,
                },
              ];
      } else if (operation === "deduplicate")
        nodes = [{ id, type: "deduplicate", input, keys, keep }];
      else if (operation === "group")
        nodes = [{ id, type: "group", input, keys, aggregates }];
      else {
        const source: PreparationNode = {
          id: newDataId(),
          type: "source",
          datasetId: other,
        };
        nodes = [
          source,
          operation === "append"
            ? { id, type: "append", inputs: [input, source.id] }
            : {
                id,
                type: "join",
                left: input,
                right: source.id,
                keys: [{ left: fieldId, right: rightKey }],
                mode,
                cardinality,
                rightPrefix: newDataId() + ".",
                rightNamePrefix:
                  (sources.find((s) => s.id === other)?.name ?? "") + " / ",
              },
        ];
      }
      await onApply(nodes);
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
            onChange={(e) => {
              setOperation(e.target.value as typeof operation);
              setKeys(
                e.target.value === "group" ? [] : fields.map((f) => f.id),
              );
              setError(null);
            }}
          >
            {operations.map((op) => (
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
        {["rename", "cast", "replace", "join"].includes(operation) ? (
          <ColumnSelect
            label={t(operation === "join" ? "leftKey" : "field")}
            fields={fields}
            value={fieldId}
            onChange={setFieldId}
          />
        ) : null}
        {["rename", "calculate"].includes(operation) ? (
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
        {operation === "append" || operation === "join" ? (
          <div className="field">
            <label htmlFor={otherId}>{t("otherDataset")}</label>
            <select
              id={otherId}
              required
              value={other}
              onChange={(e) => setOther(e.target.value)}
            >
              <option value="">{t("choose")}</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {operation === "join" ? (
          <>
            <ColumnSelect
              label={t("rightKey")}
              fields={otherFields}
              value={rightKey}
              onChange={setRightKey}
              disabled={loadingOther}
            />
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
            disabled={busy || loadingOther}
          >
            {t(busy ? "previewing" : "applyStep")}
          </button>
          <button type="button" onClick={onCancel} disabled={busy}>
            {t("cancel")}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
