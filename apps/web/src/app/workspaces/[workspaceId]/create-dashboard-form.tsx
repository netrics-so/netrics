"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import type {
  DashboardTemplateOptionsResponse,
  WorkspaceImage,
} from "@netrics/contracts";
import {
  BUILTIN_THEMES,
  DEFAULT_THEME_KEY,
  checkAccentContrast,
} from "@netrics/domain";

import {
  apiErrorMessage,
  createDashboard,
  createDashboardFromTemplate,
  getDashboardTemplates,
  fetchResourceIcon,
} from "@/lib/api";
import { brandAccent } from "@/lib/dominant-color";
import { readIconPixels } from "@/lib/icon-pixels";

type Choice = "blank" | "overview" | "brand";
type BrandResource =
  DashboardTemplateOptionsResponse["brand"]["resources"][number];

/** New dashboards start on the default theme; the accent is checked on it. */
const SURFACE = BUILTIN_THEMES[DEFAULT_THEME_KEY].tokens.surface;
const THEME_ACCENT = BUILTIN_THEMES[DEFAULT_THEME_KEY].tokens.accent;

const CHOICES: ReadonlyArray<{ id: Choice; title: string; text: string }> = [
  { id: "blank", title: "Blank", text: "One empty slide to fill yourself." },
  {
    id: "overview",
    title: "Overview",
    text: "Downloads, proceeds, reviews and web numbers of all connections.",
  },
  {
    id: "brand",
    title: "Brand",
    text: "One app or site with its icon, colour and own numbers.",
  },
];

function resourceKey(resource: { connectionId: string; resourceId: string }) {
  return `${resource.connectionId}|${resource.resourceId}`;
}

/**
 * "New dashboard": blank, or from a template (ADR 0015 section 9, #226).
 * Templates are generated on the server; the Brand template's icon is
 * fetched by the server too, and its accent is the icon's dominant colour
 * made readable on the theme (or the theme's own accent). Every choice
 * opens the new dashboard in the Studio.
 */
export function CreateDashboardForm({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [choice, setChoice] = useState<Choice>("blank");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [options, setOptions] =
    useState<DashboardTemplateOptionsResponse | null>(null);
  const [resource, setResource] = useState<string>("");
  const [icon, setIcon] = useState<WorkspaceImage | null>(null);
  const [iconState, setIconState] = useState<
    "idle" | "loading" | "missing" | "ready"
  >("idle");
  const [accent, setAccent] = useState<string | null>(null);
  // Reading the icon's colour; the form waits for it (#248).
  const [readingAccent, setReadingAccent] = useState(false);

  useEffect(() => {
    if (choice === "blank" || options) return;
    let cancelled = false;
    getDashboardTemplates(workspaceId)
      .then((loaded) => {
        if (!cancelled) setOptions(loaded);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(apiErrorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [choice, options, workspaceId]);

  const resources = useMemo(() => options?.brand.resources ?? [], [options]);
  const selected: BrandResource | undefined = resources.find(
    (entry) => resourceKey(entry) === resource,
  );

  // The chosen app's icon and the accent derived from it.
  useEffect(() => {
    setIcon(null);
    setAccent(null);
    setReadingAccent(false);
    if (!selected) {
      setIconState("idle");
      return;
    }
    if (!selected.iconSupported) {
      setIconState("missing");
      return;
    }
    let cancelled = false;
    setIconState("loading");
    fetchResourceIcon(workspaceId, selected.connectionId, selected.resourceId)
      .then(async ({ image }) => {
        if (cancelled) return;
        setIcon(image);
        setIconState("ready");
        setReadingAccent(true);
        // Always settles (null after a timeout): the theme accent then.
        const pixels = await readIconPixels(image.url);
        if (cancelled) return;
        setAccent(pixels ? brandAccent(pixels, SURFACE) : null);
        setReadingAccent(false);
      })
      .catch(() => {
        if (!cancelled) {
          setIconState("missing");
          setReadingAccent(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected, workspaceId]);

  const groups = useMemo(() => {
    const byConnection = new Map<string, BrandResource[]>();
    for (const entry of resources) {
      byConnection.set(entry.connectionId, [
        ...(byConnection.get(entry.connectionId) ?? []),
        entry,
      ]);
    }
    return [...byConnection.values()];
  }, [resources]);

  const contrast = accent
    ? checkAccentContrast(accent, { surface: SURFACE })
    : null;
  const overviewEmpty =
    options !== null && options.overview.sources.length === 0;
  const brandEmpty = options !== null && resources.length === 0;
  const canSubmit =
    !pending &&
    (choice === "blank"
      ? name.trim() !== ""
      : choice === "overview"
        ? options !== null && !overviewEmpty
        : selected !== undefined &&
          iconState !== "loading" &&
          !readingAccent &&
          contrast?.level !== "fail");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const trimmed = name.trim();
    try {
      const { dashboard } =
        choice === "blank"
          ? await createDashboard(workspaceId, { name: trimmed })
          : choice === "overview"
            ? await createDashboardFromTemplate(workspaceId, {
                template: "overview",
                ...(trimmed ? { name: trimmed } : {}),
              })
            : await createDashboardFromTemplate(workspaceId, {
                template: "brand",
                connectionId: selected!.connectionId,
                resourceId: selected!.resourceId,
                ...(trimmed ? { name: trimmed } : {}),
                accentColor: accent,
                logoImageId: icon?.id ?? null,
              });
      router.push(
        `/workspaces/${workspaceId}/dashboards/${dashboard.id}/studio`,
      );
    } catch (cause) {
      setError(apiErrorMessage(cause));
      setPending(false);
    }
  }

  return (
    <form className="new-dashboard" onSubmit={onSubmit}>
      <fieldset className="new-dashboard-choices" disabled={pending}>
        <legend>New dashboard</legend>
        {CHOICES.map((entry) => (
          <label key={entry.id} className="new-dashboard-choice">
            <input
              type="radio"
              name="template"
              value={entry.id}
              checked={choice === entry.id}
              onChange={() => {
                setChoice(entry.id);
                setError(null);
              }}
            />
            <strong>{entry.title}</strong>
            <span>{entry.text}</span>
          </label>
        ))}
      </fieldset>

      {choice === "overview" && options ? (
        overviewEmpty ? (
          <p className="muted">
            Connect a source first: the Overview shows the numbers of your
            connections.
          </p>
        ) : (
          <p className="muted">
            From{" "}
            {options.overview.sources
              .map((source) => source.connectionName)
              .join(", ")}
            . Only what is connected is shown.
          </p>
        )
      ) : null}

      {choice === "brand" && options ? (
        brandEmpty ? (
          <p className="muted">
            No apps or sites yet: they appear once a connection has synced.
          </p>
        ) : (
          <div className="new-dashboard-brand">
            {icon ? (
              <img
                className="new-dashboard-icon"
                src={icon.url}
                alt=""
                width={64}
                height={64}
              />
            ) : null}
            <div className="field">
              <label htmlFor="brand-resource">App or site</label>
              <select
                id="brand-resource"
                value={resource}
                disabled={pending}
                onChange={(event) => {
                  setResource(event.target.value);
                  const next = resources.find(
                    (entry) => resourceKey(entry) === event.target.value,
                  );
                  if (next) setName(next.name);
                }}
              >
                <option value="">Choose one</option>
                {groups.map((group) => (
                  <optgroup
                    key={group[0]!.connectionId}
                    label={group[0]!.connectionName}
                  >
                    {group.map((entry) => (
                      <option
                        key={resourceKey(entry)}
                        value={resourceKey(entry)}
                      >
                        {entry.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            {selected ? (
              <div className="field">
                <label htmlFor="brand-accent">Accent colour</label>
                <div className="new-dashboard-accent">
                  <input
                    id="brand-accent"
                    type="color"
                    value={accent ?? THEME_ACCENT}
                    disabled={pending || readingAccent}
                    onChange={(event) => setAccent(event.target.value)}
                  />
                  <code>{accent ?? THEME_ACCENT}</code>
                </div>
              </div>
            ) : null}
            {selected ? (
              <p className="muted" role="status">
                {iconState === "loading"
                  ? "Fetching the app icon…"
                  : iconState === "missing"
                    ? "No icon available; you can upload a logo in the Studio. "
                    : null}
                {iconState !== "loading"
                  ? readingAccent
                    ? "Reading the icon’s colour…"
                    : accent
                      ? contrast?.level === "fail"
                        ? `This colour is too hard to read on a TV (${contrast.ratio}:1, at least 3:1).`
                        : `Accent ${accent} from the icon, ${contrast?.ratio}:1 on the theme.`
                      : "The theme’s accent colour is used."
                  : null}
              </p>
            ) : null}
          </div>
        )
      ) : null}

      <div className="new-dashboard-row">
        <div className="field">
          <label htmlFor="dashboard-name">Name</label>
          <input
            id="dashboard-name"
            name="name"
            type="text"
            required={choice === "blank"}
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={
              choice === "overview"
                ? "Overview"
                : choice === "brand"
                  ? (selected?.name ?? "The app’s name")
                  : "Sales"
            }
            disabled={pending}
          />
        </div>
        <button type="submit" className="primary" disabled={!canSubmit}>
          {pending
            ? "Creating…"
            : choice === "blank"
              ? "Create"
              : "Create from template"}
        </button>
      </div>
      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
    </form>
  );
}
