"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { DataImpact } from "@netrics/contracts";
import { useT } from "@/lib/i18n/client";

/**
 * Saves (when needed), then asks before publishing. A record that existed
 * before this publish is confirmed with the impact list; a new one has no
 * dependents and publishes directly. Answers whether it published.
 */
export async function publishAfterConfirmation<T>(steps: {
  existed: boolean;
  save: () => Promise<T>;
  confirm: (saved: T) => Promise<boolean>;
  publish: (saved: T) => Promise<void>;
}): Promise<"published" | "cancelled"> {
  const saved = await steps.save();
  if (steps.existed && !(await steps.confirm(saved))) return "cancelled";
  await steps.publish(saved);
  return "published";
}

export interface ImpactCheck {
  impact: DataImpact;
  /** Widgets reading a measure whose draft differs from the live release. */
  changedWidgetIds?: readonly string[];
}

/**
 * The publish confirmation's state: `ask(load)` opens the dialog while
 * `load` runs and settles true on Publish, false on Cancel (or Escape).
 */
export function useImpactConfirmation(name: string) {
  const [state, setState] = useState<{
    impact: DataImpact | "loading" | "failed";
    changedWidgetIds: ReadonlySet<string>;
    resolve: (confirmed: boolean) => void;
  } | null>(null);
  const ask = (load: () => Promise<ImpactCheck>) =>
    new Promise<boolean>((resolve) => {
      setState({ impact: "loading", changedWidgetIds: new Set(), resolve });
      const settle = (next: {
        impact: DataImpact | "failed";
        changedWidgetIds?: readonly string[];
      }) =>
        setState((current) =>
          current?.resolve === resolve
            ? {
                ...current,
                impact: next.impact,
                changedWidgetIds: new Set(next.changedWidgetIds ?? []),
              }
            : current,
        );
      load().then(settle, () => settle({ impact: "failed" }));
    });
  const answer = (confirmed: boolean) => {
    state?.resolve(confirmed);
    setState(null);
  };
  const dialog = state ? (
    <PublishImpactDialog
      name={name}
      impact={state.impact}
      changedWidgetIds={state.changedWidgetIds}
      onConfirm={() => answer(true)}
      onCancel={() => answer(false)}
    />
  ) : null;
  return { ask, dialog };
}

/**
 * The publish confirmation (11C "Impact before publish"): what depends on
 * the item, across every project. Never blocks: Publish stays enabled while
 * the list loads and when it could not be read.
 */
export function PublishImpactDialog({
  name,
  impact,
  changedWidgetIds = new Set(),
  onConfirm,
  onCancel,
}: {
  name: string;
  impact: DataImpact | "loading" | "failed";
  changedWidgetIds?: ReadonlySet<string>;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT("data.impact");
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="studio-dialog publish-impact"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id={titleId}>{t("title", { name })}</h2>
      {impact === "loading" ? (
        <p role="status" className="muted">
          {t("loading")}
        </p>
      ) : impact === "failed" ? (
        <p role="alert" className="notice">
          {t("failed")}
        </p>
      ) : (
        <ImpactList impact={impact} changedWidgetIds={changedWidgetIds} />
      )}
      <div className="actions">
        <button type="button" className="primary" onClick={onConfirm}>
          {t("confirm")}
        </button>
        <button type="button" onClick={onCancel}>
          {t("cancel")}
        </button>
      </div>
    </dialog>
  );
}

function ImpactList({
  impact,
  changedWidgetIds,
}: {
  impact: DataImpact;
  changedWidgetIds: ReadonlySet<string>;
}) {
  const t = useT("data.impact");
  const { hidden } = impact;
  const total =
    impact.preparations.length +
    impact.models.length +
    impact.measures.length +
    impact.dashboards.length +
    impact.screens.length +
    hidden.preparations +
    hidden.models +
    hidden.dashboards +
    hidden.screens;
  if (total === 0) return <p className="muted">{t("none")}</p>;
  const preparationTarget = impact.target.kind === "preparation";
  // A model release keeps the preparation version it was published with,
  // so its dashboards and screens change only when it is published again.
  const pinned =
    preparationTarget && impact.models.some((m) => m.pinnedVersion !== null);
  const section = (
    key: "preparations" | "models" | "measures" | "dashboards" | "screens",
    items: ReactNode[],
    unnamed = 0,
  ) =>
    items.length + unnamed > 0 ? (
      <section key={key}>
        <h3>{t(key, { count: items.length + unnamed })}</h3>
        {pinned && (key === "dashboards" || key === "screens") ? (
          <p className="muted">{t("pinnedSection")}</p>
        ) : null}
        <ul>
          {items}
          {unnamed > 0 ? (
            <li className="muted">{t("hidden", { count: unnamed })}</li>
          ) : null}
        </ul>
      </section>
    ) : null;
  return (
    <div className="publish-impact-list">
      <p className="muted">{t("scope")}</p>
      {section(
        "preparations",
        impact.preparations.map((p) => <li key={p.id}>{p.name}</li>),
        hidden.preparations,
      )}
      {section(
        "models",
        impact.models.map((m) => (
          <li key={m.id}>
            {m.name}
            {preparationTarget && m.pinnedVersion !== null ? (
              <span className="muted">
                {" "}
                {t("pinned", { version: m.pinnedVersion })}
              </span>
            ) : null}
          </li>
        )),
        hidden.models,
      )}
      {section(
        "measures",
        impact.measures.map((m) => <li key={m.id}>{m.name}</li>),
      )}
      {section(
        "dashboards",
        impact.dashboards.map((d) => (
          <li key={d.id}>
            {d.name}
            {d.viaFilter ? (
              <span className="muted"> {t("viaFilter")}</span>
            ) : null}
            {d.widgets.length ? (
              <ul>
                {d.widgets.map((w) => (
                  <li key={w.id}>
                    {w.title ?? t("untitledWidget")}
                    {changedWidgetIds.has(w.id) ? (
                      <span className="data-badge"> {t("changed")}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        )),
        hidden.dashboards,
      )}
      {section(
        "screens",
        impact.screens.map((s) => <li key={s.id}>{s.name}</li>),
        hidden.screens,
      )}
    </div>
  );
}
