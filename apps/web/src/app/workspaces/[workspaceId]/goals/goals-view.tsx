"use client";

import { useEffect, useRef, useState } from "react";

import type { Goal, WorkspaceMetric } from "@netrics/contracts";
import { periodLabel, type Locale } from "@netrics/domain";

import { GoalForm } from "@/components/goals/goal-form";
import type { StudioCurrency } from "@/components/studio-editor/widget-panel";
import { apiErrorMessage, deleteGoal } from "@/lib/api";
import {
  formatGoalNumber,
  goalMetrics,
  goalNumbers,
  progressPercent,
  targetUnit,
} from "@/lib/goals";
import { useLocale, useT } from "@/lib/i18n/client";
import { findMetric } from "@/lib/studio-inspector";

type Editing = { key: number; goal: Goal | null } | null;

/** "83 %" in the reader's language, rounded down. */
function percentText(progress: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(progressPercent(progress) / 100);
}

/**
 * The Goals page (ADR 0019 §4): each goal with its metric, period and a
 * progress bar; a form to create and edit them, and a delete confirmation
 * that names the dashboards whose gauges show the goal.
 */
export function GoalsView({
  workspaceId,
  goals: initial,
  metrics,
  timeZone,
  currency,
  canCreate,
  canEdit,
  canDelete,
}: {
  workspaceId: string;
  goals: Goal[];
  metrics: WorkspaceMetric[];
  timeZone: string;
  currency: StudioCurrency;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const t = useT("goals");
  const [goals, setGoals] = useState(initial);
  const [editing, setEditing] = useState<Editing>(null);
  const panel = useRef<HTMLElement>(null);
  const reached = goals.filter(
    (goal) => (goal.current?.progress ?? 0) >= 1,
  ).length;
  const canPick = goalMetrics(metrics).length > 0;

  useEffect(() => {
    if (editing) {
      panel.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      panel.current?.focus({ preventScroll: true });
    }
  }, [editing]);

  function saved(goal: Goal) {
    setGoals((list) => {
      const others = list.filter((other) => other.id !== goal.id);
      return [...others, goal].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      );
    });
    setEditing(null);
  }

  return (
    <>
      <header className="page-header">
        <div>
          <h1>{t("title")}</h1>
          <p className="page-meta">
            {reached > 0
              ? t("metaReached", { count: goals.length, reached })
              : t("meta", { count: goals.length })}
          </p>
        </div>
        {canCreate && canPick ? (
          <div className="page-actions">
            <button
              type="button"
              className="primary goals-new"
              aria-expanded={editing?.goal === null}
              aria-controls="goal-editor"
              onClick={() => setEditing({ key: Date.now(), goal: null })}
            >
              <span aria-hidden="true">+</span> {t("newGoal")}
            </button>
          </div>
        ) : null}
      </header>

      {editing ? (
        <section
          id="goal-editor"
          ref={panel}
          className="card goal-editor"
          tabIndex={-1}
          aria-labelledby="goal-editor-title"
        >
          <h2 id="goal-editor-title">
            {editing.goal ? t("form.editTitle") : t("form.createTitle")}
          </h2>
          <GoalForm
            key={editing.key}
            workspaceId={workspaceId}
            metrics={metrics}
            currency={currency}
            goal={editing.goal}
            onSaved={saved}
            onCancel={() => setEditing(null)}
          />
        </section>
      ) : null}

      {goals.length === 0 ? (
        <div className="goals-empty">
          <h2>{t("empty.title")}</h2>
          <p>
            {!canCreate
              ? t("empty.readOnly")
              : canPick
                ? t("empty.text")
                : t("noMetrics")}
          </p>
        </div>
      ) : (
        <ul className="goals-list" aria-label={t("list")}>
          {goals.map((goal) => (
            <GoalCard
              key={goal.id}
              workspaceId={workspaceId}
              goal={goal}
              metric={findMetric(metrics, goal)}
              timeZone={timeZone}
              canEdit={canEdit}
              canDelete={canDelete}
              onEdit={() => setEditing({ key: Date.now(), goal })}
              onDeleted={() =>
                setGoals((list) => list.filter((other) => other.id !== goal.id))
              }
            />
          ))}
        </ul>
      )}
    </>
  );
}

export function GoalCard({
  workspaceId,
  goal,
  metric,
  timeZone,
  canEdit,
  canDelete,
  onEdit,
  onDeleted,
}: {
  workspaceId: string;
  goal: Goal;
  metric: WorkspaceMetric | undefined;
  timeZone: string;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const t = useT("goals");
  const common = useT("common");
  const locale = useLocale();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = goal.current;
  const progress = current?.progress ?? null;
  const isReached = progress !== null && progress >= 1;
  const unit = targetUnit(
    metric?.unit ?? "",
    current?.currency
      ? { dimensions: { currency: current.currency }, displayCurrency: null }
      : goal,
  );
  const numbers = goalNumbers(goal, metric?.unit ?? "", locale);
  const scope = goal.resourceName ?? goal.allResourcesName;
  const source = [metric?.name ?? goal.metricKey, scope, metric?.connectionName]
    .filter(Boolean)
    .join(" · ");

  let status: string;
  if (current === null) {
    status = t("unavailable");
  } else if (current.value === null || progress === null) {
    status = t("noData");
  } else if (isReached) {
    // Daily metrics count by reporting date; others in the workspace zone.
    status =
      current.reachedAt && goal.period !== "today"
        ? t("reachedOn", {
            date: new Intl.DateTimeFormat(locale, {
              day: "numeric",
              month: "short",
              timeZone: metric?.granularity === "day" ? "UTC" : timeZone,
            }).format(new Date(current.reachedAt)),
          })
        : t("reached");
  } else {
    status = t("toGo", {
      amount: formatGoalNumber(goal.target - current.value, unit, locale),
    });
  }

  async function remove() {
    setDeleting(true);
    setError(null);
    try {
      await deleteGoal(workspaceId, goal.id);
      onDeleted();
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
      setDeleting(false);
    }
  }

  const fill = progress === null ? 0 : Math.min(Math.max(progress, 0), 1);
  const percent = progress === null ? null : percentText(progress, locale);

  return (
    <li className={`goal-card${isReached ? " goal-card--reached" : ""}`}>
      <div className="goal-card-head">
        <div className="goal-card-title">
          <h2 className="goal-card-name">{goal.name}</h2>
          <p className="goal-card-source">{source}</p>
        </div>
        <span className="goal-chip" title={t("period")}>
          {periodLabel(goal.period, locale)}
        </span>
      </div>

      <div className="goal-card-numbers">
        <span className="goal-card-value">
          {t.rich("valueOfTarget", {
            value: (
              <strong key="value">
                {current?.approximate ? "≈ " : ""}
                {numbers.value}
              </strong>
            ),
            target: numbers.target,
          })}
        </span>
        {percent ? <span className="goal-card-percent">{percent}</span> : null}
      </div>
      <div
        className="goal-bar"
        role="progressbar"
        aria-label={t("progressLabel", {
          name: goal.name,
          percent: percent ?? "—",
        })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={
          progress === null ? undefined : progressPercent(progress)
        }
      >
        <span
          className="goal-bar-fill"
          style={{ width: `${(fill * 100).toFixed(2)}%` }}
        />
      </div>
      <p className="goal-card-status">
        {isReached ? <span aria-hidden="true">✓ </span> : null}
        {status}
        {current?.approximate ? (
          <span className="visually-hidden"> {t("approximate")}</span>
        ) : null}
      </p>

      {confirming ? (
        <div
          className="goal-confirm"
          role="group"
          aria-label={t("deleteNamed", { name: goal.name })}
        >
          <p>
            <strong>{t("confirmDelete", { name: goal.name })}</strong>{" "}
            {goal.dashboards.length > 0
              ? t("usedOn", {
                  count: goal.dashboards.length,
                  names: new Intl.ListFormat(locale, {
                    type: "conjunction",
                  }).format(goal.dashboards.map((d) => d.name)),
                })
              : t("notUsed")}
          </p>
          {error ? (
            <div className="error" role="alert">
              {error}
            </div>
          ) : null}
          <div className="actions">
            <button
              type="button"
              className="danger"
              disabled={deleting}
              onClick={() => void remove()}
            >
              {deleting ? common("deleting") : t("deleteConfirmed")}
            </button>
            <button
              type="button"
              disabled={deleting}
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
            >
              {common("cancel")}
            </button>
          </div>
        </div>
      ) : canEdit || canDelete ? (
        <div className="goal-card-actions">
          {canEdit ? (
            <button
              type="button"
              className="link-button"
              aria-label={t("editNamed", { name: goal.name })}
              onClick={onEdit}
            >
              {t("edit")}
            </button>
          ) : null}
          {canDelete ? (
            <button
              type="button"
              className="link-button goal-delete"
              aria-label={t("deleteNamed", { name: goal.name })}
              onClick={() => setConfirming(true)}
            >
              {t("delete")}
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
