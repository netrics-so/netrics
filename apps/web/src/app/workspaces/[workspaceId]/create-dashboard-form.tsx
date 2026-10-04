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
  type ScreenFormat,
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
import { useLocale, useT } from "@/lib/i18n/client";
import { PREVIEW_FORMAT_ORDER } from "@/lib/studio-formats";
import { formatRatio } from "@/components/studio-editor/format-attention";
import { FormatGlyph } from "@/components/studio-editor/format-switcher";

export type Choice = "blank" | "overview" | "brand";
type BrandResource =
  DashboardTemplateOptionsResponse["brand"]["resources"][number];

/** New dashboards start on the default theme; the accent is checked on it. */
const SURFACE = BUILTIN_THEMES[DEFAULT_THEME_KEY].tokens.surface;
const THEME_ACCENT = BUILTIN_THEMES[DEFAULT_THEME_KEY].tokens.accent;

const CHOICES: readonly Choice[] = ["blank", "overview", "brand"];

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
export function CreateDashboardForm({
  workspaceId,
  initialChoice = "blank",
}: {
  workspaceId: string;
  /** The template preselected, e.g. from a template card (#304). */
  initialChoice?: Choice;
}) {
  const locale = useLocale();
  const t = useT("workspace.newDashboard");
  const common = useT("common");
  const router = useRouter();
  const [choice, setChoice] = useState<Choice>(initialChoice);
  // The primary format of a blank dashboard (ADR 0017); templates are 16:9.
  const [format, setFormat] = useState<ScreenFormat>("16x9");
  const formatsT = useT("studio.formats");
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
        if (!cancelled) setError(apiErrorMessage(cause, locale));
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
          ? await createDashboard(workspaceId, {
              name: trimmed,
              ...(format === "16x9" ? {} : { primaryFormat: format }),
            })
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
      setError(apiErrorMessage(cause, locale));
      setPending(false);
    }
  }

  return (
    <form className="new-dashboard" onSubmit={onSubmit}>
      <fieldset className="new-dashboard-choices" disabled={pending}>
        <legend>{t("legend")}</legend>
        {CHOICES.map((entry) => (
          <label key={entry} className="new-dashboard-choice">
            <input
              type="radio"
              name="template"
              value={entry}
              checked={choice === entry}
              onChange={() => {
                setChoice(entry);
                setError(null);
              }}
            />
            <strong>{t(`choices.${entry}.title`)}</strong>
            <span>{t(`choices.${entry}.text`)}</span>
          </label>
        ))}
      </fieldset>

      {choice === "blank" ? (
        <fieldset className="new-dashboard-formats" disabled={pending}>
          <legend>{t("format")}</legend>
          <div className="new-dashboard-format-list">
            {PREVIEW_FORMAT_ORDER.map((entry) => (
              <label key={entry} className="new-dashboard-format">
                <input
                  type="radio"
                  name="primary-format"
                  value={entry}
                  checked={format === entry}
                  onChange={() => setFormat(entry)}
                />
                <FormatGlyph target={entry} />
                <span className="new-dashboard-format-ratio">
                  {formatRatio(entry)}
                </span>
                <span>{formatsT(`names.${entry}`)}</span>
              </label>
            ))}
          </div>
          <p className="muted">{t("formatHelp")}</p>
        </fieldset>
      ) : (
        <p className="muted">{t("templateFormat")}</p>
      )}

      {choice === "overview" && options ? (
        overviewEmpty ? (
          <p className="muted">{t("overviewEmpty")}</p>
        ) : (
          <p className="muted">
            {t("overviewFrom", {
              sources: new Intl.ListFormat(locale).format(
                options.overview.sources.map((source) => source.connectionName),
              ),
            })}
          </p>
        )
      ) : null}

      {choice === "brand" && options ? (
        brandEmpty ? (
          <p className="muted">{t("brandEmpty")}</p>
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
              <label htmlFor="brand-resource">{t("appOrSite")}</label>
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
                <option value="">{t("chooseOne")}</option>
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
                <label htmlFor="brand-accent">{t("accent")}</label>
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
                  ? t("fetchingIcon")
                  : iconState === "missing"
                    ? `${t("noIcon")} `
                    : null}
                {iconState !== "loading"
                  ? readingAccent
                    ? t("readingColour")
                    : accent
                      ? contrast?.level === "fail"
                        ? t("tooLowContrast", { ratio: contrast.ratio })
                        : t("accentFromIcon", {
                            accent,
                            ratio: contrast?.ratio ?? "",
                          })
                      : t("themeAccent")
                  : null}
              </p>
            ) : null}
          </div>
        )
      ) : null}

      <div className="new-dashboard-row">
        <div className="field">
          <label htmlFor="dashboard-name">{t("name")}</label>
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
                ? t("placeholderOverview")
                : choice === "brand"
                  ? (selected?.name ?? t("placeholderBrand"))
                  : t("placeholderBlank")
            }
            disabled={pending}
          />
        </div>
        <button type="submit" className="primary" disabled={!canSubmit}>
          {pending
            ? common("creating")
            : choice === "blank"
              ? common("create")
              : t("createFromTemplate")}
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
