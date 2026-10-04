"use client";

import Link from "next/link";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from "react";

import type { Device } from "@netrics/contracts";

import { DeviceControls } from "../device-controls";
import type { HeartbeatSummary } from "@/lib/device-heartbeat";
import { useT } from "@/lib/i18n/client";
import type { ScreenCounts, ScreenPreview } from "@/lib/screens";

/** One screen as the page shows it; texts are worded on the server. */
export interface ScreenItem {
  device: Device;
  online: boolean;
  /** "5 minutes ago", or "never". */
  lastSeen: string;
  /** When it was revoked ("2 days ago"), else null. */
  revoked: string | null;
  dashboardName: string | null;
  preview: ScreenPreview;
  appleTv: boolean;
  heartbeat: HeartbeatSummary | null;
  /** "3840 × 2160 · 16:9 · Screen view · Portrait", or null before one. */
  screenLine: string | null;
  /** The day it was paired, as a date. */
  paired: string;
}

export type ScreensViewMode = "cards" | "table";

interface ScreensViewProps {
  workspaceId: string;
  screens: ScreenItem[];
  counts: ScreenCounts;
  dashboards: Array<{ id: string; name: string }>;
  /** Owners and admins: connect, change and revoke screens. */
  canManage: boolean;
  initialView?: ScreensViewMode;
  initialSelected?: string | null;
}

/**
 * All screens of a workspace (#303): cards with a thumbnail of what each
 * shows, or a compact table; selecting one opens its details beside the
 * list (below it on phones) with today's device controls.
 */
export function ScreensView({
  workspaceId,
  screens,
  counts,
  dashboards,
  canManage,
  initialView = "cards",
  initialSelected = null,
}: ScreensViewProps) {
  const t = useT("screens");
  const w = useT("workspace");
  const panelId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const [view, setView] = useState<ScreensViewMode>(initialView);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelected);
  const selected =
    screens.find((screen) => screen.device.id === selectedId) ?? null;

  // On phones the details open below the list: bring them into view.
  useEffect(() => {
    if (
      selectedId !== null &&
      panelRef.current &&
      window.matchMedia("(max-width: 1099px)").matches
    ) {
      panelRef.current.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [selectedId]);

  const toggle = (id: string) =>
    setSelectedId((current) => (current === id ? null : id));

  const active = screens.filter((screen) => screen.revoked === null);
  const revoked = screens.filter((screen) => screen.revoked !== null);

  const card = (screen: ScreenItem) => (
    <li key={screen.device.id}>
      <ScreenCard
        screen={screen}
        selected={screen.device.id === selectedId}
        panelId={panelId}
        onSelect={() => toggle(screen.device.id)}
      />
    </li>
  );

  return (
    <div className="area-page screens-page">
      <header className="page-header">
        <div>
          <h1>{t("title")}</h1>
          <p className="page-meta">
            {w("screenCount", { total: counts.total, online: counts.online })}
          </p>
        </div>
        <div className="page-actions">
          {screens.length > 0 ? (
            <div className="view-switch" role="group" aria-label={t("views")}>
              {(["cards", "table"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={view === mode}
                  onClick={() => setView(mode)}
                >
                  {t(mode)}
                </button>
              ))}
            </div>
          ) : null}
          {canManage ? (
            <Link href="/devices/approve" className="button primary">
              {t("connectTv")}
            </Link>
          ) : null}
        </div>
      </header>

      {screens.length === 0 ? (
        <div className="card screens-empty">
          <h2>{t("emptyTitle")}</h2>
          <p>{canManage ? t("emptyBody") : t("emptyViewer")}</p>
          {canManage ? (
            <Link href="/devices/approve" className="button primary">
              {t("connectTv")}
            </Link>
          ) : null}
        </div>
      ) : (
        <div
          className={`screens-layout${selected ? " screens-layout--open" : ""}`}
        >
          <div className="screens-main">
            {view === "cards" ? (
              <>
                {active.length > 0 ? (
                  <ul className="screen-grid">{active.map(card)}</ul>
                ) : null}
                {revoked.length > 0 ? (
                  <details
                    className="screens-revoked"
                    open={active.length === 0 || selected?.revoked != null}
                  >
                    <summary>
                      {t("revokedSection", { count: revoked.length })}
                    </summary>
                    <ul className="screen-grid">{revoked.map(card)}</ul>
                  </details>
                ) : null}
              </>
            ) : (
              <ScreensTable
                screens={[...active, ...revoked]}
                selectedId={selectedId}
                panelId={panelId}
                onSelect={toggle}
              />
            )}
            {selected ? null : (
              <p className="muted screens-hint">{t("selectHint")}</p>
            )}
          </div>
          {selected ? (
            <ScreenPanel
              ref={panelRef}
              id={panelId}
              screen={selected}
              workspaceId={workspaceId}
              dashboards={dashboards}
              canManage={canManage}
              onClose={() => setSelectedId(null)}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

/** The 8 px status dot with its state for screen readers. */
function StatusDot({ screen }: { screen: ScreenItem }) {
  const t = useT("screens");
  const state =
    screen.revoked !== null ? "revoked" : screen.online ? "online" : "offline";
  return (
    <>
      <span className={`status-dot status-dot--${state}`} aria-hidden="true" />
      <span className="visually-hidden">{t(state)}</span>
    </>
  );
}

/** What the screen shows: its dashboard's first slide, in its theme. */
export function ScreenThumbnail({
  preview,
  offline,
}: {
  preview: ScreenPreview;
  offline: boolean;
}) {
  const t = useT("screens");
  return (
    <span
      className="screen-thumb"
      style={
        {
          background: preview.background,
          "--thumb-surface": preview.surface,
          "--thumb-border": preview.border,
          "--thumb-muted": preview.muted,
        } as CSSProperties
      }
      aria-hidden="true"
    >
      <span
        className={`screen-thumb-slide${
          preview.tall ? " screen-thumb-slide--tall" : ""
        }`}
        style={{ aspectRatio: preview.aspectRatio }}
      >
        {preview.stubs.map((stub, index) => (
          <span
            key={index}
            className={`screen-thumb-widget${
              stub.quiet ? " screen-thumb-widget--quiet" : ""
            }`}
            style={{
              left: `${stub.left}%`,
              top: `${stub.top}%`,
              width: `${stub.width}%`,
              height: `${stub.height}%`,
            }}
          />
        ))}
      </span>
      {offline ? (
        <span className="screen-thumb-offline">{t("offline")}</span>
      ) : null}
    </span>
  );
}

function ScreenCard({
  screen,
  selected,
  panelId,
  onSelect,
}: {
  screen: ScreenItem;
  selected: boolean;
  panelId: string;
  onSelect: () => void;
}) {
  const t = useT("screens");
  const isRevoked = screen.revoked !== null;
  return (
    <button
      type="button"
      className={`screen-card${isRevoked ? " screen-card--revoked" : ""}`}
      aria-pressed={selected}
      aria-controls={selected ? panelId : undefined}
      onClick={onSelect}
    >
      <ScreenThumbnail
        preview={screen.preview}
        offline={!isRevoked && !screen.online}
      />
      <span className="screen-card-row">
        <StatusDot screen={screen} />
        <span className="screen-card-name">{screen.device.name}</span>
        <span className="screen-card-seen">{screen.lastSeen}</span>
      </span>
      <span className="screen-card-row">
        <span
          className={`screen-card-dashboard${
            screen.dashboardName ? "" : " screen-card-dashboard--none"
          }`}
        >
          {screen.dashboardName ?? t("noDashboard")}
        </span>
        {isRevoked ? (
          <span className="role-badge screen-card-badge">{t("revoked")}</span>
        ) : null}
      </span>
    </button>
  );
}

function ScreensTable({
  screens,
  selectedId,
  panelId,
  onSelect,
}: {
  screens: ScreenItem[];
  selectedId: string | null;
  panelId: string;
  onSelect: (id: string) => void;
}) {
  const t = useT("screens");
  return (
    <div className="card table-scroll screens-table-card">
      <table className="table screens-table">
        <thead>
          <tr>
            <th scope="col">{t("columns.name")}</th>
            <th scope="col">{t("columns.status")}</th>
            <th scope="col">{t("columns.dashboard")}</th>
            <th scope="col">{t("columns.lastSeen")}</th>
            <th scope="col">{t("columns.app")}</th>
            <th scope="col">{t("columns.screen")}</th>
          </tr>
        </thead>
        <tbody>
          {screens.map((screen) => {
            const selected = screen.device.id === selectedId;
            const state =
              screen.revoked !== null
                ? "revoked"
                : screen.online
                  ? "online"
                  : "offline";
            return (
              <tr
                key={screen.device.id}
                className={[
                  selected ? "is-selected" : "",
                  screen.revoked !== null ? "is-revoked" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <td>
                  <button
                    type="button"
                    className="screens-table-name"
                    aria-pressed={selected}
                    aria-controls={selected ? panelId : undefined}
                    onClick={() => onSelect(screen.device.id)}
                  >
                    <span
                      className={`status-dot status-dot--${state}`}
                      aria-hidden="true"
                    />
                    {screen.device.name}
                  </button>
                </td>
                <td className="nowrap">{t(state)}</td>
                <td>{screen.dashboardName ?? t("noDashboard")}</td>
                <td className="nowrap">{screen.lastSeen}</td>
                <td className="nowrap">{screen.heartbeat?.version ?? "—"}</td>
                <td>{screen.screenLine ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface ScreenPanelProps {
  ref: Ref<HTMLElement>;
  id: string;
  screen: ScreenItem;
  workspaceId: string;
  dashboards: Array<{ id: string; name: string }>;
  canManage: boolean;
  onClose: () => void;
}

/** A screen's health and settings; Escape closes it. */
function ScreenPanel({
  ref,
  id,
  screen,
  workspaceId,
  dashboards,
  canManage,
  onClose,
}: ScreenPanelProps) {
  const t = useT("screens");
  const { device, heartbeat } = screen;
  const state =
    screen.revoked !== null ? "revoked" : screen.online ? "online" : "offline";
  return (
    <aside
      ref={ref}
      id={id}
      className="card screen-panel"
      aria-label={t("details")}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onClose();
        }
      }}
    >
      <div className="screen-panel-head">
        <ScreenThumbnail
          preview={screen.preview}
          offline={state === "offline"}
        />
        <div className="screen-panel-title">
          <h2>{device.name}</h2>
          <span className={`screen-state screen-state--${state}`}>
            <span
              className={`status-dot status-dot--${state}`}
              aria-hidden="true"
            />
            {t(state)}
          </span>
        </div>
        <button
          type="button"
          className="screen-panel-close"
          aria-label={t("close")}
          title={t("close")}
          onClick={onClose}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <section className="screen-panel-section">
        <h3>{t("health")}</h3>
        <dl className="screen-facts">
          <dt>{t("lastSeen")}</dt>
          <dd>{screen.lastSeen}</dd>
          <dt>{t("dashboard")}</dt>
          <dd>{screen.dashboardName ?? t("noDashboard")}</dd>
          <dt>{t("app")}</dt>
          <dd>
            {heartbeat
              ? t("heartbeat", {
                  version: heartbeat.version,
                  time: heartbeat.at,
                })
              : t("noHeartbeat")}
          </dd>
          <dt>{t("screen")}</dt>
          <dd>{screen.screenLine ?? t("screenNotReported")}</dd>
          <dt>{t("paired")}</dt>
          <dd>{screen.paired}</dd>
          <dt>{t("lastError")}</dt>
          <dd
            className={heartbeat?.lastError ? "screen-error" : undefined}
            title={heartbeat?.lastErrorFull ?? undefined}
          >
            {heartbeat?.lastError ?? t("noError")}
          </dd>
        </dl>
      </section>

      {screen.revoked !== null ? (
        <p className="muted">{t("revokedNote", { time: screen.revoked })}</p>
      ) : canManage ? (
        <section className="screen-panel-section screen-panel-settings">
          <h3>{t("settings")}</h3>
          <DeviceControls
            key={device.id}
            workspaceId={workspaceId}
            device={device}
            appleTv={screen.appleTv}
            dashboards={dashboards}
          />
        </section>
      ) : (
        <p className="muted">{t("readOnly")}</p>
      )}
    </aside>
  );
}
