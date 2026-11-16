"use client";
import { useId, useState } from "react";
import {
  VISUAL_ARITHMETIC,
  type DataField,
  type DataType,
  type VisualArithmeticOperator,
  type VisualCalculation,
  type VisualCondition,
  type VisualOperand,
  type VisualValue,
  type VisualWrap,
} from "@netrics/domain";
import type { BuilderChoices } from "@/lib/builder-choices";
import { useT } from "@/lib/i18n/client";
import {
  ConditionBuilder,
  emptyComparison,
  FieldOptions,
  type BuilderNoun,
} from "./condition-builder";
import { fixedValueMode, typedNumericLiteral } from "@/lib/literal-input";
import { emptyLiteral, LiteralField } from "./literal-field";

const LITERAL_TYPES: readonly DataType[] = [
  "decimal",
  "integer",
  "number",
  "string",
  "boolean",
  "date",
  "timestamp",
];
const numericTypes: readonly DataType[] = ["integer", "number", "decimal"];
const emptyField = (): VisualOperand => ({ kind: "field", fieldId: "" });
const emptyCondition = (): VisualCondition => ({
  kind: "condition",
  join: "and",
  items: [emptyComparison()],
});

/** The type of an operand, when the builder knows it. */
function operandType(
  operand: VisualOperand | null,
  choices: BuilderChoices,
): DataType | undefined {
  return operand?.kind === "field"
    ? choices.field(operand.fieldId)?.type
    : operand?.kind === "literal"
      ? operand.literal.type
      : undefined;
}

/** One operand: a column (from the offered ones) or a typed value. */
function OperandField({
  label,
  operand,
  partner,
  fields,
  choices,
  noun,
  invalidFieldId,
  onChange,
}: {
  label: string;
  operand: VisualOperand;
  /** The value next to this one, whose type a new fixed value follows. */
  partner: VisualOperand | null;
  fields: readonly DataField[];
  choices: BuilderChoices;
  noun: BuilderNoun;
  invalidFieldId?: string;
  onChange: (operand: VisualOperand) => void;
}) {
  const t = useT("data"),
    id = useId();
  // A value opened with the builder keeps its type; a new one is typed from
  // its neighbour or its text until a type is picked (#630).
  const [picked, setPicked] = useState(
    operand.kind === "literal" && operand.literal.value !== null,
  );
  const mode = picked ? null : fixedValueMode(operandType(partner, choices));
  const inputType =
    operand.kind !== "literal"
      ? null
      : mode === null
        ? operand.literal.type
        : mode === "typed"
          ? numericTypes.includes(operand.literal.type)
            ? "decimal"
            : operand.literal.type
          : mode;
  return (
    <div role="group" aria-label={label} className="data-builder-row">
      <div className="field">
        <label htmlFor={id + "-source"}>{t("builder.source")}</label>
        <select
          id={id + "-source"}
          value={operand.kind}
          onChange={(e) => {
            const next = fixedValueMode(operandType(partner, choices));
            setPicked(false);
            onChange(
              e.target.value === "field"
                ? emptyField()
                : {
                    kind: "literal",
                    literal: emptyLiteral(next === "typed" ? "integer" : next),
                  },
            );
          }}
        >
          <option value="field">{t(`builder.${noun}`)}</option>
          <option value="literal">{t("builder.fixedValue")}</option>
        </select>
      </div>
      {operand.kind === "field" ? (
        <div className="field">
          <label htmlFor={id + "-field"}>{t(`builder.${noun}`)}</label>
          <select
            id={id + "-field"}
            value={operand.fieldId}
            aria-invalid={
              (!!invalidFieldId && invalidFieldId === operand.fieldId) ||
              undefined
            }
            onChange={(e) =>
              onChange({ kind: "field", fieldId: e.target.value })
            }
          >
            <FieldOptions
              fields={fields}
              value={operand.fieldId}
              all={choices.fields}
            />
          </select>
        </div>
      ) : (
        <>
          <div className="field">
            <label htmlFor={id + "-type"}>{t("type")}</label>
            <select
              id={id + "-type"}
              value={operand.literal.type}
              onChange={(e) => {
                setPicked(true);
                onChange({
                  kind: "literal",
                  literal: emptyLiteral(e.target.value as DataType),
                });
              }}
            >
              {(LITERAL_TYPES.includes(operand.literal.type)
                ? LITERAL_TYPES
                : [operand.literal.type, ...LITERAL_TYPES]
              ).map((type) => (
                <option key={type} value={type}>
                  {t(`types.${type}`)}
                </option>
              ))}
            </select>
          </div>
          <LiteralField
            label={t("builder.fixedValue")}
            type={inputType!}
            literal={operand.literal}
            currency={
              inputType === "decimal" &&
              (operand.literal.currency !== undefined ||
                choices.fields.some((field) => field.unit === "currency"))
            }
            onChange={(literal) =>
              onChange({
                kind: "literal",
                literal:
                  mode === "typed" ? typedNumericLiteral(literal) : literal,
              })
            }
          />
        </>
      )}
    </div>
  );
}

/** An operand, or two operands with an arithmetic operator. */
function ValueEditor({
  label,
  value,
  partner,
  role,
  choices,
  noun,
  invalidFieldId,
  onChange,
}: {
  label: string;
  value: VisualValue;
  /** The value next to this one (other branch, wrapped value), if any. */
  partner: VisualOperand | null;
  role: "value" | "branch";
  choices: BuilderChoices;
  noun: BuilderNoun;
  invalidFieldId?: string;
  onChange: (value: VisualValue) => void;
}) {
  const t = useT("data"),
    id = useId();
  const left = value.kind === "arithmetic" ? value.left : value;
  const right = value.kind === "arithmetic" ? value.right : null;
  const offered = choices.arithmetic(left, right ?? emptyField());
  const operator = value.kind === "arithmetic" ? value.operator : "";
  const operators: VisualArithmeticOperator[] =
    operator && !offered.includes(operator) ? [operator, ...offered] : offered;
  const leftFields = right
    ? choices.operandFields(right, "arithmetic")
    : role === "branch"
      ? choices.operandFields(partner, "branch")
      : choices.fields;
  return (
    <div className="data-builder-value">
      <OperandField
        label={label}
        operand={left}
        partner={right ?? (role === "branch" ? partner : null)}
        fields={leftFields}
        choices={choices}
        noun={noun}
        invalidFieldId={invalidFieldId}
        onChange={(operand) =>
          onChange(
            value.kind === "arithmetic" ? { ...value, left: operand } : operand,
          )
        }
      />
      <div className="field">
        <label htmlFor={id}>{t("builder.operation")}</label>
        <select
          id={id}
          value={operator}
          onChange={(e) => {
            const next = e.target.value as VisualArithmeticOperator | "";
            onChange(
              next === ""
                ? left
                : {
                    kind: "arithmetic",
                    operator: next,
                    left,
                    right: right ?? emptyField(),
                  },
            );
          }}
        >
          <option value="">{t("builder.arithmetic.none")}</option>
          {VISUAL_ARITHMETIC.filter((op) => operators.includes(op)).map(
            (op) => (
              <option key={op} value={op}>
                {t(`builder.arithmetic.${op}`)}
              </option>
            ),
          )}
        </select>
      </div>
      {value.kind === "arithmetic" ? (
        <OperandField
          label={t("builder.secondValue")}
          operand={value.right}
          partner={value.left}
          fields={choices.operandFields(value.left, "arithmetic")}
          choices={choices}
          noun={noun}
          invalidFieldId={invalidFieldId}
          onChange={(operand) => onChange({ ...value, right: operand })}
        />
      ) : null}
    </div>
  );
}

const asOperand = (value: VisualValue): VisualOperand | null =>
  value.kind === "arithmetic" ? null : value;

function WrapEditor({
  wrap,
  value,
  choices,
  noun,
  invalidFieldId,
  onChange,
}: {
  wrap: VisualWrap | undefined;
  value: VisualValue;
  choices: BuilderChoices;
  noun: BuilderNoun;
  invalidFieldId?: string;
  onChange: (wrap: VisualWrap | undefined) => void;
}) {
  const t = useT("data"),
    id = useId();
  return (
    <>
      <div className="field">
        <label htmlFor={id}>{t("builder.result")}</label>
        <select
          id={id}
          value={wrap?.fn ?? "none"}
          onChange={(e) => {
            const fn = e.target.value;
            onChange(
              fn === "round"
                ? { fn: "round", digits: 0 }
                : fn === "abs"
                  ? { fn: "abs" }
                  : fn === "coalesce"
                    ? { fn: "coalesce", fallback: emptyField() }
                    : undefined,
            );
          }}
        >
          {(["none", "round", "abs", "coalesce"] as const).map((fn) => (
            <option key={fn} value={fn}>
              {t(`builder.wrap.${fn}`)}
            </option>
          ))}
        </select>
      </div>
      {wrap?.fn === "round" ? (
        <div className="field">
          <label htmlFor={id + "-digits"}>{t("builder.digits")}</label>
          <input
            id={id + "-digits"}
            type="number"
            min={0}
            max={18}
            step={1}
            value={Number.isSafeInteger(wrap.digits) ? wrap.digits : ""}
            onChange={(e) => {
              const digits = Number(e.target.value);
              onChange({
                fn: "round",
                digits:
                  e.target.value !== "" &&
                  Number.isInteger(digits) &&
                  digits >= 0 &&
                  digits <= 18
                    ? digits
                    : Number.NaN,
              });
            }}
          />
        </div>
      ) : null}
      {wrap?.fn === "coalesce" ? (
        <OperandField
          label={t("builder.wrap.coalesce")}
          operand={wrap.fallback}
          partner={asOperand(value)}
          fields={choices.operandFields(asOperand(value), "fallback")}
          choices={choices}
          noun={noun}
          invalidFieldId={invalidFieldId}
          onChange={(fallback) => onChange({ fn: "coalesce", fallback })}
        />
      ) : null}
    </>
  );
}

/** A value (optionally wrapped), an if … then … otherwise, or a condition. */
export function CalculationBuilder({
  model,
  choices,
  noun = "column",
  invalidFieldId,
  onChange,
}: {
  model: VisualCalculation;
  choices: BuilderChoices;
  noun?: BuilderNoun;
  invalidFieldId?: string;
  onChange: (model: VisualCalculation) => void;
}) {
  const t = useT("data"),
    id = useId();
  const switchKind = (kind: VisualCalculation["kind"]) => {
    const value: VisualValue =
      model.kind === "value"
        ? model.value
        : model.kind === "if"
          ? model.then
          : emptyField();
    const condition =
      model.kind === "value" ? emptyCondition() : model.condition;
    onChange(
      kind === "value"
        ? { kind, value }
        : kind === "if"
          ? { kind, condition, then: value, else: emptyField() }
          : { kind, condition },
    );
  };
  return (
    <div className="data-builder">
      <div className="field">
        <label htmlFor={id}>{t("builder.kind")}</label>
        <select
          id={id}
          value={model.kind}
          onChange={(e) =>
            switchKind(e.target.value as VisualCalculation["kind"])
          }
        >
          {(["value", "if", "boolean"] as const).map((kind) => (
            <option key={kind} value={kind}>
              {t(`builder.kinds.${kind}`)}
            </option>
          ))}
        </select>
      </div>
      {model.kind === "value" ? (
        <>
          <ValueEditor
            label={t("builder.value")}
            value={model.value}
            partner={null}
            role="value"
            choices={choices}
            noun={noun}
            invalidFieldId={invalidFieldId}
            onChange={(value) => onChange({ ...model, value })}
          />
          <WrapEditor
            wrap={model.wrap}
            value={model.value}
            choices={choices}
            noun={noun}
            invalidFieldId={invalidFieldId}
            onChange={(wrap) => {
              const { wrap: _wrap, ...rest } = model;
              onChange(wrap ? { ...rest, wrap } : rest);
            }}
          />
        </>
      ) : (
        <ConditionBuilder
          condition={model.condition}
          choices={choices}
          noun={noun}
          invalidFieldId={invalidFieldId}
          onChange={(condition) => onChange({ ...model, condition })}
        />
      )}
      {model.kind === "if" ? (
        <>
          <ValueEditor
            label={t("builder.then")}
            value={model.then}
            partner={asOperand(model.else)}
            role="branch"
            choices={choices}
            noun={noun}
            invalidFieldId={invalidFieldId}
            onChange={(then) => onChange({ ...model, then })}
          />
          <ValueEditor
            label={t("builder.else")}
            value={model.else}
            partner={asOperand(model.then)}
            role="branch"
            choices={choices}
            noun={noun}
            invalidFieldId={invalidFieldId}
            onChange={(otherwise) => onChange({ ...model, else: otherwise })}
          />
        </>
      ) : null}
    </div>
  );
}
