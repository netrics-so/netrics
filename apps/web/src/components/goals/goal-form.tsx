"use client";

import { useId, useState, type FormEvent } from "react";

import {
  metricWidgetOptionsSchema,
  type Goal,
  type WorkspaceMetric,
} from "@netrics/contracts";
import { GOAL_LIMITS, isGoalAggregation } from "@netrics/domain";

import {
  DataFields,
  type StudioCurrency,
} from "@/components/studio-editor/widget-panel";
import { ApiError, apiErrorMessage, createGoal, updateGoal } from "@/lib/api";
import {
  goalMetrics,
  targetFromDisplay,
  targetToDisplay,
  targetUnit,
} from "@/lib/goals";
import { useLocale, useT } from "@/lib/i18n/client";
import type { StudioAction } from "@/lib/studio-document";
import { findMetric } from "@/lib/studio-inspector";
import type { DataWidget } from "@/lib/studio-widgets";

/** The binding as the Studio's metric picker edits it: a metric widget. */
type Binding = Extract<DataWidget, { type: "metric" }>;

const BINDING_BASE = {
  id: "00000000-0000-4000-8000-000000000000",
  type: "metric",
  x: 0,
  y: 0,
  w: 3,
  h: 2,
  title: null,
  options: metricWidgetOptionsSchema.parse({}),
} as const;

/** A goal's binding, or a first one for a new goal; null without metrics. */
export function initialBinding(
  goal: Goal | null,
  metrics: readonly WorkspaceMetric[],
): Binding | null {
  if (goal) {
    return {
      ...BINDING_BASE,
      connectionId: goal.connectionId,
      metricKey: goal.metricKey,
      aggregation: goal.aggregation,
      period: goal.period,
      dimensions: goal.dimensions,
      displayCurrency: goal.displayCurrency,
      resourceName: goal.resourceName,
      allResourcesName: goal.allResourcesName,
    };
  }
  const first = goalMetrics(metrics)[0];
  const aggregation = first?.aggregations.find(isGoalAggregation);
  if (!first || !aggregation) return null;
  return {
    ...BINDING_BASE,
    connectionId: first.connectionId,
    metricKey: first.key,
    aggregation,
    period: "this_month",
    dimensions: {},
    displayCurrency: null,
    resourceName: null,
    allResourcesName: null,
  };
}

export interface GoalFormProps {
  workspaceId: string;
  metrics: readonly WorkspaceMetric[];
  currency?: StudioCurrency;
  /** The goal to edit; a new one without. */
  goal?: Goal | null;
  onSaved: (goal: Goal) => void;
  onCancel: () => void;
}

/**
 * Create or edit a goal (ADR 0019 §4): name, the metric binding with the
 * Studio inspector's picker, period, and the target in display units
 * (major units, percent) with its unit beside it. The Studio's gauge
 * picker (#339) opens it in a dialog.
 */
export function GoalForm({
  workspaceId,
  metrics,
  currency,
  goal = null,
  onSaved,
  onCancel,
}: GoalFormProps) {
  const t = useT("goals.form");
  const page = useT("goals");
  const common = useT("common");
  const locale = useLocale();
  const id = useId();
  const [name, setName] = useState(goal?.name ?? "");
  const [binding, setBinding] = useState<Binding | null>(() =>
    initialBinding(goal, metrics),
  );
  const metric = binding ? findMetric(metrics, binding) : undefined;
  const unit = targetUnit(metric?.unit ?? "", {
    dimensions: binding?.dimensions ?? {},
    displayCurrency: binding?.displayCurrency ?? null,
  });
  const [targetInput, setTargetInput] = useState(() =>
    goal ? String(targetToDisplay(goal.target, unit)) : "",
  );
  const [targetTouched, setTargetTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!binding) {
    return <p className="muted">{page("noMetrics")}</p>;
  }

  const dispatch = (action: StudioAction) => {
    if (action.type === "updateWidget") {
      setBinding((current) =>
        current ? ({ ...current, ...action.patch } as Binding) : current,
      );
    }
  };

  const target = targetFromDisplay(targetInput, unit);
  const targetInvalid = targetTouched && target === null;
  const unitLabel =
    unit.kind === "currency"
      ? unit.currency
      : unit.kind === "percent"
        ? "%"
        : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTargetTouched(true);
    if (!binding || target === null) return;
    setSaving(true);
    setError(null);
    const body = {
      name: name.trim(),
      connectionId: binding.connectionId,
      metricKey: binding.metricKey,
      aggregation: binding.aggregation,
      period: binding.period,
      dimensions: binding.dimensions,
      displayCurrency: binding.displayCurrency,
      target,
    };
    try {
      const saved = goal
        ? await updateGoal(workspaceId, goal.id, {
            ...body,
            version: goal.version,
          })
        : await createGoal(workspaceId, body);
      onSaved(saved.goal);
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.code === "version_conflict"
          ? t("versionConflict")
          : apiErrorMessage(cause, locale),
      );
      setSaving(false);
    }
  }

  return (
    <form className="goal-form" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor={`${id}-name`}>{t("name")}</label>
        <input
          id={`${id}-name`}
          type="text"
          required
          value={name}
          maxLength={GOAL_LIMITS.nameLength}
          placeholder={t("namePlaceholder")}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <DataFields
        widget={binding}
        metric={metric}
        metrics={metrics}
        workspaceId={workspaceId}
        {...(currency ? { currency } : {})}
        dispatch={dispatch}
        goal
      />

      <div className="field">
        <label htmlFor={`${id}-target`}>{t("target")}</label>
        <span className="goal-target-row">
          <input
            id={`${id}-target`}
            type="text"
            inputMode="decimal"
            required
            value={targetInput}
            aria-invalid={targetInvalid || undefined}
            aria-describedby={`${id}-target-help`}
            onChange={(event) => setTargetInput(event.target.value)}
            onBlur={() => setTargetTouched(true)}
          />
          {unitLabel ? (
            <span className="goal-target-unit">{unitLabel}</span>
          ) : null}
        </span>
        {targetInvalid ? (
          <p className="field-error" role="alert">
            {t("targetInvalid")}
          </p>
        ) : null}
        <p id={`${id}-target-help`} className="help">
          {binding.aggregation === "last"
            ? t("targetHelpLast")
            : t("targetHelp")}
        </p>
      </div>

      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="actions">
        <button
          type="submit"
          className="primary"
          disabled={saving || name.trim() === ""}
        >
          {saving ? common("saving") : goal ? t("save") : t("create")}
        </button>
        <button type="button" onClick={onCancel} disabled={saving}>
          {common("cancel")}
        </button>
      </div>
    </form>
  );
}
