"use client";
import { useId } from "react";
import {
  reconcileComparison,
  type DataField,
  type DataLiteral,
  type DataType,
  type VisualComparison,
  type VisualComparisonOperator,
  type VisualCondition,
  type VisualGroup,
} from "@netrics/domain";
import type { BuilderChoices } from "@/lib/builder-choices";
import { useT } from "@/lib/i18n/client";
import { emptyLiteral, ListField, LiteralField } from "./literal-field";

export type BuilderNoun = "column" | "measure";

export function emptyComparison(): VisualComparison {
  return { kind: "comparison", fieldId: "", operator: "eq", negated: false };
}

/** Field options of a select: the offered fields, plus the chosen one if it is missing. */
export function FieldOptions({
  fields,
  value,
  all = fields,
}: {
  fields: readonly DataField[];
  value: string;
  /** Every field of the input, to name a chosen field that is not offered. */
  all?: readonly DataField[];
}) {
  const t = useT("data");
  const chosen = all.find((field) => field.id === value);
  return (
    <>
      <option value="" disabled>
        {t("choose")}
      </option>
      {value && !fields.some((field) => field.id === value) ? (
        <option value={value}>
          {chosen ? chosen.name : t("builder.missing", { id: value })}
        </option>
      ) : null}
      {fields.map((field) => (
        <option key={field.id} value={field.id}>
          {field.name}
        </option>
      ))}
    </>
  );
}

/** The item type of a list literal whose column is missing: read from its items. */
function listItemType(literal: DataLiteral | undefined): DataType {
  const first: unknown = Array.isArray(literal?.value)
    ? (literal.value as unknown[])[0]
    : undefined;
  return typeof first === "number"
    ? "number"
    : typeof first === "boolean"
      ? "boolean"
      : "string";
}

/** A boolean value starts as false (shown by the switch) rather than empty. */
function withDefaultRight(
  row: VisualComparison,
  choices: BuilderChoices,
): VisualComparison {
  const field = choices.field(row.fieldId);
  if (
    row.right ||
    !field ||
    field.type !== "boolean" ||
    row.operator === "is_null" ||
    row.operator === "in"
  )
    return row;
  return {
    ...row,
    right: { kind: "literal", literal: emptyLiteral("boolean") },
  };
}

function ComparisonRow({
  row,
  number,
  choices,
  noun,
  invalidFieldId,
  onChange,
  onRemove,
}: {
  row: VisualComparison;
  number: number;
  choices: BuilderChoices;
  noun: BuilderNoun;
  invalidFieldId?: string;
  onChange: (row: VisualComparison) => void;
  onRemove: () => void;
}) {
  const t = useT("data"),
    id = useId();
  const field = choices.field(row.fieldId);
  const offered = field ? choices.operators(field) : [];
  const operators: VisualComparisonOperator[] = offered.includes(row.operator)
    ? offered
    : [row.operator, ...offered];
  const rightFields =
    field && row.operator !== "in" && row.operator !== "is_null"
      ? choices.rightFields(field, row.operator)
      : [];
  const right = row.right;
  const literal = right?.kind === "literal" ? right.literal : undefined;
  const literalType: DataType | null = field
    ? field.type === "json"
      ? null
      : field.type
    : row.operator === "in"
      ? listItemType(literal)
      : (literal?.type ?? null);
  const reconcile = (next: VisualComparison) =>
    onChange(
      withDefaultRight(reconcileComparison(next, choices.fields), choices),
    );
  const invalid = !!invalidFieldId && invalidFieldId === row.fieldId;
  const offerColumn = rightFields.length > 0 || right?.kind === "field";
  return (
    <div
      role="group"
      aria-label={t("builder.condition", { number })}
      className="data-builder-row"
    >
      <div className="field">
        <label htmlFor={id + "-field"}>{t(`builder.${noun}`)}</label>
        <select
          id={id + "-field"}
          value={row.fieldId}
          aria-invalid={invalid || undefined}
          onChange={(e) => reconcile({ ...row, fieldId: e.target.value })}
        >
          <FieldOptions
            fields={choices.comparable()}
            value={row.fieldId}
            all={choices.fields}
          />
        </select>
      </div>
      <div className="field">
        <label htmlFor={id + "-operator"}>{t("builder.operator")}</label>
        <select
          id={id + "-operator"}
          value={row.operator}
          disabled={!row.fieldId}
          onChange={(e) =>
            reconcile({
              ...row,
              operator: e.target.value as VisualComparisonOperator,
            })
          }
        >
          {operators.map((operator) => (
            <option key={operator} value={operator}>
              {t(`builder.operators.${operator}`)}
            </option>
          ))}
        </select>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={row.negated}
          onChange={(e) => onChange({ ...row, negated: e.target.checked })}
        />
        {t("builder.negated")}
      </label>
      {row.operator === "is_null" || !row.fieldId ? null : (
        <>
          {offerColumn && row.operator !== "in" ? (
            <div
              role="radiogroup"
              aria-label={t("builder.compareWith")}
              className="data-builder-inline"
            >
              <label className="check">
                <input
                  type="radio"
                  name={id + "-right"}
                  checked={right?.kind !== "field"}
                  onChange={() =>
                    onChange(
                      withDefaultRight({ ...row, right: undefined }, choices),
                    )
                  }
                />
                {t("builder.value")}
              </label>
              <label className="check">
                <input
                  type="radio"
                  name={id + "-right"}
                  checked={right?.kind === "field"}
                  onChange={() =>
                    onChange({ ...row, right: { kind: "field", fieldId: "" } })
                  }
                />
                {t("builder.otherColumn")}
              </label>
            </div>
          ) : null}
          {right?.kind === "field" ? (
            <div className="field">
              <label htmlFor={id + "-other"}>{t("builder.otherColumn")}</label>
              <select
                id={id + "-other"}
                value={right.fieldId}
                onChange={(e) =>
                  onChange({
                    ...row,
                    right: { kind: "field", fieldId: e.target.value },
                  })
                }
              >
                <FieldOptions
                  fields={rightFields}
                  value={right.fieldId}
                  all={choices.fields}
                />
              </select>
            </div>
          ) : literalType === null ? null : row.operator === "in" ? (
            <ListField
              label={t("builder.value")}
              type={literalType}
              literal={literal}
              invalid={invalid}
              onChange={(next) =>
                onChange({ ...row, right: { kind: "literal", literal: next } })
              }
            />
          ) : (
            <LiteralField
              label={t("builder.value")}
              type={literalType}
              literal={literal}
              invalid={invalid}
              currency={
                field?.unit === "currency" || literal?.currency !== undefined
              }
              onChange={(next) =>
                onChange({ ...row, right: { kind: "literal", literal: next } })
              }
            />
          )}
        </>
      )}
      <button type="button" onClick={onRemove}>
        {t("builder.remove")}
      </button>
    </div>
  );
}

function JoinSelect({
  value,
  onChange,
}: {
  value: "and" | "or";
  onChange: (join: "and" | "or") => void;
}) {
  const t = useT("data"),
    id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{t("builder.join")}</label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as "and" | "or")}
      >
        <option value="and">{t("builder.all")}</option>
        <option value="or">{t("builder.any")}</option>
      </select>
    </div>
  );
}

/** Condition rows joined by all/any, with one level of groups. */
export function ConditionBuilder({
  condition,
  choices,
  noun = "column",
  invalidFieldId,
  onChange,
}: {
  condition: VisualCondition;
  choices: BuilderChoices;
  noun?: BuilderNoun;
  invalidFieldId?: string;
  onChange: (condition: VisualCondition) => void;
}) {
  const t = useT("data");
  const setItem = (
    index: number,
    item: VisualComparison | VisualGroup | null,
  ) =>
    onChange({
      ...condition,
      items:
        item === null
          ? condition.items.filter((_, i) => i !== index)
          : condition.items.map((current, i) => (i === index ? item : current)),
    });
  let rowNumber = 0,
    groupNumber = 0;
  return (
    <div className="data-builder">
      <JoinSelect
        value={condition.join}
        onChange={(join) => onChange({ ...condition, join })}
      />
      {condition.items.map((item, index) => {
        if (item.kind === "comparison")
          return (
            <ComparisonRow
              key={index}
              row={item}
              number={++rowNumber}
              choices={choices}
              noun={noun}
              invalidFieldId={invalidFieldId}
              onChange={(row) => setItem(index, row)}
              onRemove={() => setItem(index, null)}
            />
          );
        const group = item;
        const setRow = (rowIndex: number, row: VisualComparison | null) => {
          const rows =
            row === null
              ? group.rows.filter((_, i) => i !== rowIndex)
              : group.rows.map((current, i) =>
                  i === rowIndex ? row : current,
                );
          setItem(index, rows.length ? { ...group, rows } : null);
        };
        return (
          <div
            key={index}
            role="group"
            aria-label={t("builder.group", { number: ++groupNumber })}
            className="data-builder-group"
          >
            <JoinSelect
              value={group.join}
              onChange={(join) => setItem(index, { ...group, join })}
            />
            {group.rows.map((row, rowIndex) => (
              <ComparisonRow
                key={rowIndex}
                row={row}
                number={++rowNumber}
                choices={choices}
                noun={noun}
                invalidFieldId={invalidFieldId}
                onChange={(next) => setRow(rowIndex, next)}
                onRemove={() => setRow(rowIndex, null)}
              />
            ))}
            <div className="data-form-actions">
              <button
                type="button"
                onClick={() =>
                  setItem(index, {
                    ...group,
                    rows: [...group.rows, emptyComparison()],
                  })
                }
              >
                {t("builder.addCondition")}
              </button>
              <button type="button" disabled>
                {t("builder.addGroup")}
              </button>
              <button type="button" onClick={() => setItem(index, null)}>
                {t("builder.remove")}
              </button>
            </div>
          </div>
        );
      })}
      <div className="data-form-actions">
        <button
          type="button"
          onClick={() =>
            onChange({
              ...condition,
              items: [...condition.items, emptyComparison()],
            })
          }
        >
          {t("builder.addCondition")}
        </button>
        <button
          type="button"
          onClick={() =>
            onChange({
              ...condition,
              items: [
                ...condition.items,
                {
                  kind: "group",
                  join: condition.join === "and" ? "or" : "and",
                  rows: [emptyComparison()],
                },
              ],
            })
          }
        >
          {t("builder.addGroup")}
        </button>
      </div>
    </div>
  );
}
