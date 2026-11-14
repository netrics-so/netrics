"use client";
import { useId, useMemo, useState } from "react";
import {
  DataProcessingError,
  visualProblem,
  type DataExpression,
  type DataField,
  type VisualCalculation,
  type VisualTarget,
} from "@netrics/domain";
import { builderChoices } from "@/lib/builder-choices";
import { dataErrorCodeKey } from "@/lib/data-errors";
import {
  initialExpressionDraft,
  switchExpressionView,
  type ExpressionDraft,
} from "@/lib/expression-draft";
import { useT } from "@/lib/i18n/client";
import { CalculationBuilder } from "./calculation-builder";
import { ConditionBuilder, type BuilderNoun } from "./condition-builder";
import { FormulaInput } from "./formula-input";

/**
 * Edits one expression as visual rows or as formula text. Controlled: the
 * draft lives with the caller, and only edits mark it edited.
 */
export function ExpressionEditor({
  label,
  target,
  fields,
  noun = "column",
  initial,
  draft,
  onDraftChange,
  problem,
}: {
  label: string;
  target: VisualTarget;
  fields: readonly DataField[];
  noun?: BuilderNoun;
  initial: DataExpression | undefined;
  draft: ExpressionDraft | undefined;
  onDraftChange: (draft: ExpressionDraft) => void;
  problem?: { code: string; fieldId?: string };
}) {
  const t = useT("data"),
    id = useId();
  const current = useMemo(
    () => draft ?? initialExpressionDraft(initial, target, fields),
    [draft, initial, target, fields],
  );
  const choices = useMemo(() => builderChoices(fields), [fields]);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const model = current.view === "visual" ? current.model : null;
  const edited = current.edited;
  const inline = useMemo(
    () => (model && edited ? visualProblem(model, fields, target) : null),
    [model, edited, fields, target],
  );
  // An unfinished model is reported when saving, not while it is being built.
  const shown = inline && inline.code !== "builder_incomplete" ? inline : null;
  const invalidFieldId = problem?.fieldId ?? shown?.fieldId;
  const switchTo = (view: ExpressionDraft["view"]) => {
    if (view === current.view) return;
    try {
      onDraftChange(switchExpressionView(current, target, fields));
      setSwitchError(null);
    } catch (error) {
      if (!(error instanceof DataProcessingError)) throw error;
      setSwitchError(error.code);
    }
  };
  const visualEdit = (next: ExpressionDraft & { view: "visual" }) => {
    setSwitchError(null);
    onDraftChange(next);
  };
  return (
    <div className="data-expression-editor">
      <div className="data-builder-heading">
        {current.view === "formula" ? (
          <label htmlFor={id + "-formula"}>{label}</label>
        ) : (
          <span id={id + "-label"} className="label">
            {label}
          </span>
        )}
        <div
          role="radiogroup"
          aria-label={t("builder.view")}
          className="data-builder-views"
        >
          {(["visual", "formula"] as const).map((view) => (
            <label key={view} className="check">
              <input
                type="radio"
                name={id + "-view"}
                value={view}
                checked={current.view === view}
                onChange={() => switchTo(view)}
              />
              {t(view === "visual" ? "builder.visual" : "formula")}
            </label>
          ))}
        </div>
      </div>
      {current.view === "formula" ? (
        <>
          {current.note ? (
            <p id={id + "-note"} className="help">
              {t(`builder.notVisual.${current.note}`)}
            </p>
          ) : null}
          <FormulaInput
            id={id + "-formula"}
            value={current.text}
            fields={fields}
            noun={noun}
            describedBy={current.note ? id + "-note" : undefined}
            onChange={(text) => {
              setSwitchError(null);
              onDraftChange({ ...current, text, edited: true });
            }}
          />
        </>
      ) : (
        <div role="group" aria-labelledby={id + "-label"}>
          {current.model.kind === "condition" ? (
            <ConditionBuilder
              condition={current.model}
              choices={choices}
              noun={noun}
              invalidFieldId={invalidFieldId}
              onChange={(condition) =>
                visualEdit({ view: "visual", model: condition, edited: true })
              }
            />
          ) : (
            <CalculationBuilder
              model={current.model}
              choices={choices}
              noun={noun}
              invalidFieldId={invalidFieldId}
              onChange={(calculation: VisualCalculation) =>
                visualEdit({
                  view: "visual",
                  model: calculation,
                  edited: true,
                })
              }
            />
          )}
        </div>
      )}
      {switchError || shown ? (
        <p role="alert" className="error">
          {t(`errors.${dataErrorCodeKey(switchError ?? shown!.code)}`)}
        </p>
      ) : null}
    </div>
  );
}
