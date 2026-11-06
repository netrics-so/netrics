"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

import type { Goal, WorkspaceMetric } from "@netrics/contracts";
import { goalPercent, type Locale } from "@netrics/domain";

import { GoalForm } from "@/components/goals/goal-form";
import { workspacePath } from "@/lib/app-nav";
import { useLocale, useT } from "@/lib/i18n/client";
import type { StudioAction } from "@/lib/studio-document";
import { formatPercent, type GaugeWidget } from "@/lib/studio-gauge";

import type { StudioCurrency } from "./widget-panel";

/** "Monthly downloads · 83 %": a goal as the picker lists it. */
export function goalOptionLabel(goal: Goal, locale: Locale): string {
  const percent = goalPercent(goal.current?.progress ?? null);
  return percent === null
    ? goal.name
    : `${goal.name} · ${formatPercent(percent, locale)}`;
}

/**
 * A goal widget's goal (ADR 0019 section 5): a picker of the workspace's
 * goals with their progress, "New goal…" (the goal form in a dialog, for
 * those who may create goals) and "Edit goal" on the Goals page. A gauge
 * whose goal was deleted says so and offers to pick another.
 */
export function GoalFields({
  widget,
  workspaceId,
  goals,
  metrics,
  currency,
  canCreateGoals,
  onGoalCreated,
  dispatch,
}: {
  widget: GaugeWidget;
  workspaceId: string;
  goals: readonly Goal[];
  metrics: readonly WorkspaceMetric[];
  currency?: StudioCurrency;
  canCreateGoals: boolean;
  onGoalCreated?: (goal: Goal) => void;
  dispatch: (action: StudioAction) => void;
}) {
  const t = useT("studio.widgetPanel");
  const locale = useLocale();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [creating, setCreating] = useState(false);
  const missing = widget.goalId === null;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (creating && !element.open) element.showModal();
    else if (!creating && element.open) element.close();
  }, [creating]);

  const choose = (goal: Goal) =>
    dispatch({
      type: "updateWidget",
      widgetId: widget.id,
      patch: { goalId: goal.id, goalName: goal.name },
    });

  return (
    <fieldset>
      <legend>{t("goal")}</legend>
      <div className="field">
        <label htmlFor={`${id}-goal`}>{t("goal")}</label>
        <select
          id={`${id}-goal`}
          value={widget.goalId ?? ""}
          aria-invalid={missing || undefined}
          aria-describedby={`${id}-goal-help`}
          onChange={(event) => {
            const goal = goals.find((entry) => entry.id === event.target.value);
            if (goal) choose(goal);
          }}
        >
          {missing ? <option value="">{t("goalDeleted")}</option> : null}
          {goals.map((goal) => (
            <option key={goal.id} value={goal.id}>
              {goalOptionLabel(goal, locale)}
            </option>
          ))}
        </select>
        <p
          id={`${id}-goal-help`}
          className={missing ? "help contrast-warn" : "help"}
          role={missing ? "status" : undefined}
        >
          {missing
            ? t("goalDeletedHelp")
            : goals.length === 0
              ? t("noGoals")
              : t("goalHelp")}
        </p>
      </div>
      <div className="actions goal-actions">
        {canCreateGoals ? (
          <button type="button" onClick={() => setCreating(true)}>
            {t("newGoal")}
          </button>
        ) : null}
        <Link href={workspacePath(workspaceId, "goals")}>{t("editGoal")}</Link>
      </div>
      <dialog
        ref={dialog}
        className="studio-dialog goal-dialog"
        aria-labelledby={`${id}-dialog-title`}
        onClose={() => setCreating(false)}
      >
        <h2 id={`${id}-dialog-title`}>{t("newGoalTitle")}</h2>
        {creating ? (
          <GoalForm
            workspaceId={workspaceId}
            metrics={metrics}
            {...(currency ? { currency } : {})}
            onSaved={(goal) => {
              onGoalCreated?.(goal);
              choose(goal);
              setCreating(false);
            }}
            onCancel={() => setCreating(false)}
          />
        ) : null}
      </dialog>
    </fieldset>
  );
}
