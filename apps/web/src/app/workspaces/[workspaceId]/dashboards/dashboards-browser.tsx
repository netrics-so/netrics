"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";

import type { DashboardListResponse } from "@netrics/contracts";
import { BUILTIN_THEMES, DEFAULT_THEME_KEY } from "@netrics/domain";

import { useT } from "@/lib/i18n/client";

import { CreateDashboardForm, type Choice } from "../create-dashboard-form";
import { DashboardThumbnail } from "./dashboard-thumbnail";

export type DashboardCardData = DashboardListResponse["dashboards"][number] & {
  /** "updated 5 minutes ago", worded on the server in the reader's language. */
  updatedLabel: string;
  /** The theme's name in the reader's language. */
  themeLabel: string;
};

/** The order of the template cards; Blank is last and dashed (design 3a). */
const TEMPLATES: readonly Choice[] = ["overview", "brand", "blank"];

/** The hash the home page's "New dashboard" links to. */
export const NEW_DASHBOARD_HASH = "#new-dashboard";

/** Filter value for dashboards without a project. */
const NO_PROJECT = "none";

/** Dashboards of one project, of none, or all (the filter's empty value). */
export function filterByProject<T extends { projectId: string | null }>(
  dashboards: readonly T[],
  filter: string,
): T[] {
  if (filter === "") return [...dashboards];
  return dashboards.filter((dashboard) =>
    filter === NO_PROJECT
      ? dashboard.projectId === null
      : dashboard.projectId === filter,
  );
}

/**
 * The dashboards page (ADR 0018, design 3a; #304): a project filter and
 * "New dashboard" in the header, a templates row, and cards with a
 * thumbnail of the first slide, where the dashboard is shown and its
 * theme. Templates and "New dashboard" open the create panel with that
 * choice made.
 */
export function DashboardsBrowser({
  workspaceId,
  dashboards,
  projects,
  canCreate,
  canEdit,
  title,
  meta,
}: {
  workspaceId: string;
  dashboards: DashboardCardData[];
  projects: Array<{ id: string; name: string }>;
  canCreate: boolean;
  canEdit: boolean;
  title: string;
  meta: string;
}) {
  const t = useT("dashboardsPage");
  const filterId = useId();
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState<{
    choice: Choice;
    key: number;
  } | null>(null);
  const panel = useRef<HTMLElement>(null);

  // "New dashboard" elsewhere (home quick actions) links here by hash.
  useEffect(() => {
    if (!canCreate) return;
    const openFromHash = () => {
      if (window.location.hash === NEW_DASHBOARD_HASH) {
        setCreating((open) => open ?? { choice: "blank", key: Date.now() });
      }
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, [canCreate]);

  useEffect(() => {
    if (creating) {
      panel.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      panel.current?.focus({ preventScroll: true });
    }
  }, [creating]);

  const start = (choice: Choice) => setCreating({ choice, key: Date.now() });
  const shown = filterByProject(dashboards, filter);
  const hasNoProject = dashboards.some((d) => d.projectId === null);

  return (
    <>
      <header className="page-header">
        <div>
          <h1>{title}</h1>
          <p className="page-meta">{meta}</p>
        </div>
        <div className="page-actions">
          {projects.length > 0 ? (
            <div className="dashboards-filter">
              <label htmlFor={filterId} className="visually-hidden">
                {t("projectFilter")}
              </label>
              <select
                id={filterId}
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              >
                <option value="">{t("allProjects")}</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
                {hasNoProject ? (
                  <option value={NO_PROJECT}>{t("noProject")}</option>
                ) : null}
              </select>
            </div>
          ) : null}
          {canCreate ? (
            <button
              type="button"
              className="primary dashboards-new"
              aria-expanded={creating !== null}
              aria-controls="new-dashboard"
              onClick={() => start("blank")}
            >
              <span aria-hidden="true">+</span> {t("newDashboard")}
            </button>
          ) : null}
        </div>
      </header>

      {canCreate ? (
        <section
          className="dashboards-templates"
          aria-labelledby="dashboards-templates-title"
        >
          <h2 id="dashboards-templates-title" className="section-label">
            {t("templates")}
          </h2>
          <ul className="dashboards-template-list">
            {TEMPLATES.map((choice) => (
              <li key={choice}>
                <button
                  type="button"
                  className={`dashboards-template dashboards-template--${choice}`}
                  aria-label={t("startWith", {
                    name: t(`template.${choice}.title`),
                  })}
                  aria-pressed={creating?.choice === choice}
                  onClick={() => start(choice)}
                >
                  <TemplateGlyph choice={choice} />
                  <span className="dashboards-template-text">
                    <strong>{t(`template.${choice}.title`)}</strong>
                    <span>{t(`template.${choice}.text`)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {canCreate && creating ? (
        <section
          id="new-dashboard"
          ref={panel}
          className="card dashboards-create"
          tabIndex={-1}
          aria-label={t("create")}
        >
          <button
            type="button"
            className="link-button dashboards-create-close"
            onClick={() => {
              setCreating(null);
              if (window.location.hash === NEW_DASHBOARD_HASH) {
                history.replaceState(
                  null,
                  "",
                  window.location.pathname + window.location.search,
                );
              }
            }}
          >
            {t("closeCreate")}
          </button>
          <CreateDashboardForm
            key={creating.key}
            workspaceId={workspaceId}
            initialChoice={creating.choice}
          />
        </section>
      ) : null}

      {dashboards.length === 0 ? (
        <div className="dashboards-empty">
          <h2>{t("empty.title")}</h2>
          <p>{canCreate ? t("empty.text") : t("empty.readOnly")}</p>
        </div>
      ) : shown.length === 0 ? (
        <p className="dashboards-empty">{t("emptyFilter")}</p>
      ) : (
        <ul className="dashboards-grid" aria-label={t("list")}>
          {shown.map((dashboard) => (
            <DashboardCard
              key={dashboard.id}
              workspaceId={workspaceId}
              dashboard={dashboard}
              canEdit={canEdit}
            />
          ))}
        </ul>
      )}
    </>
  );
}

export function DashboardCard({
  workspaceId,
  dashboard,
  canEdit,
}: {
  workspaceId: string;
  dashboard: DashboardCardData;
  canEdit: boolean;
}) {
  const t = useT("dashboardsPage");
  const href = `/workspaces/${workspaceId}/dashboards/${dashboard.id}`;
  return (
    <li className="dash-card">
      <DashboardThumbnail
        dashboard={dashboard}
        pill={t("slides", { count: dashboard.slideCount })}
      />
      <div className="dash-card-title">
        <span
          className="dash-card-accent"
          style={{ background: dashboard.accent }}
          aria-hidden="true"
        />
        <Link className="dash-card-name" href={href}>
          {dashboard.name}
        </Link>
        <span className="dash-card-updated">{dashboard.updatedLabel}</span>
      </div>
      <div className="dash-card-footer">
        <span className="dash-card-chips">
          {dashboard.screenCount > 0 ? (
            <span className="dash-chip dash-chip--shown">
              {t("onScreens", { count: dashboard.screenCount })}
            </span>
          ) : (
            <span className="dash-chip dash-chip--hidden">{t("notShown")}</span>
          )}
          <span
            className="dash-chip dash-chip--theme"
            title={t("theme", { name: dashboard.themeLabel })}
          >
            {dashboard.themeLabel}
          </span>
        </span>
        {canEdit ? (
          <Link
            className="dash-card-studio"
            href={`${href}/studio`}
            aria-label={t("openInStudioNamed", { name: dashboard.name })}
          >
            {t("openInStudio")}
          </Link>
        ) : null}
      </div>
    </li>
  );
}

/** Template glyphs are tiny TV slides: netrics Dark, the default theme. */
const GLYPH_STYLE = {
  "--thumb-bg": BUILTIN_THEMES[DEFAULT_THEME_KEY].tokens.background,
  "--thumb-surface": BUILTIN_THEMES[DEFAULT_THEME_KEY].tokens.border,
} as CSSProperties;

/** A small schematic per template, like the design's 44 px glyphs. */
function TemplateGlyph({ choice }: { choice: Choice }) {
  return (
    <span
      className={`template-glyph template-glyph--${choice}`}
      style={choice === "blank" ? undefined : GLYPH_STYLE}
      aria-hidden="true"
    >
      {choice === "overview" ? (
        <>
          <span />
          <span />
          <span className="template-glyph-tall" />
          <span className="template-glyph-wide" />
        </>
      ) : choice === "brand" ? (
        <span className="template-glyph-mark" />
      ) : null}
    </span>
  );
}
