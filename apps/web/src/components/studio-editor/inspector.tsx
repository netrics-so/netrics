"use client";

import { useState } from "react";

import type {
  BuiltinThemeView,
  DashboardSettings,
  WorkspaceTheme,
} from "@netrics/contracts";
import {
  SLIDE_SECONDS,
  checkAccentContrast,
  isHexColor,
  type ThemeTokens,
} from "@netrics/domain";

import {
  type StudioAction,
  type StudioDocument,
  type StudioProblem,
} from "@/lib/studio-document";

import { ImagePicker, type PickableImage } from "./image-picker";

export interface StudioThemes {
  builtins: BuiltinThemeView[];
  custom: WorkspaceTheme[];
}

/** The select value of a dashboard's theme: "builtin:<key>" or "custom:<id>". */
export function themeChoice(
  settings: Pick<DashboardSettings, "themeBuiltin" | "themeId">,
): string {
  return settings.themeId
    ? `custom:${settings.themeId}`
    : `builtin:${settings.themeBuiltin ?? "netrics_dark"}`;
}

function parseThemeChoice(
  value: string,
): Pick<DashboardSettings, "themeBuiltin" | "themeId"> {
  const [kind, id] = value.split(":") as [string, string];
  return kind === "custom"
    ? { themeBuiltin: null, themeId: id }
    : { themeBuiltin: id, themeId: null };
}

/** What a brand accent's contrast means for TVs, as the inspector says it. */
export function accentHint(accent: string, tokens: ThemeTokens) {
  const check = checkAccentContrast(accent, tokens);
  const ratio = `${check.ratio.toFixed(2)}:1`;
  switch (check.level) {
    case "fail":
      return {
        level: check.level,
        text: `Contrast ${ratio} against the widget surface: too low to read on a TV. Saving is refused below 3:1.`,
      };
    case "warn":
      return {
        level: check.level,
        text: `Contrast ${ratio} against the widget surface: hard to read from a distance (4.5:1 recommended).`,
      };
    default:
      return {
        level: check.level,
        text: `Contrast ${ratio} against the widget surface: readable.`,
      };
  }
}

function Problems({ problems }: { problems: StudioProblem[] }) {
  if (problems.length === 0) return null;
  return (
    <ul className="inspector-problems" aria-label="Problems">
      {problems.map((problem, index) => (
        <li key={index}>{problem.message}</li>
      ))}
    </ul>
  );
}

/** Dashboard settings: shown when no widget is selected. */
export function DashboardSettingsPanel({
  document,
  themes,
  baseTokens,
  projects,
  images,
  problems,
  themesHref,
  dispatch,
  onUploadImage,
}: {
  document: StudioDocument;
  themes: StudioThemes;
  /** The chosen theme's tokens before the brand accent. */
  baseTokens: ThemeTokens;
  projects: Array<{ id: string; name: string }>;
  images: PickableImage[];
  problems: StudioProblem[];
  themesHref: string;
  dispatch: (action: StudioAction) => void;
  onUploadImage?: (file: File) => Promise<string | null>;
}) {
  const { settings } = document;
  const update = (patch: Partial<DashboardSettings>) =>
    dispatch({ type: "updateSettings", patch });
  // The text field may hold an unfinished colour; the document only a valid one.
  const [accentText, setAccentText] = useState(settings.accentColor ?? "");
  const [accentFor, setAccentFor] = useState(settings.accentColor);
  if (accentFor !== settings.accentColor) {
    setAccentFor(settings.accentColor);
    setAccentText(settings.accentColor ?? "");
  }
  const hint = settings.accentColor
    ? accentHint(settings.accentColor, baseTokens)
    : null;

  return (
    <section
      className="inspector-section"
      aria-labelledby="inspector-dashboard"
    >
      <h2 id="inspector-dashboard">Dashboard</h2>
      <Problems problems={problems} />
      <div className="field">
        <label htmlFor="dashboard-name">Name</label>
        <input
          id="dashboard-name"
          type="text"
          value={document.name}
          maxLength={100}
          required
          onChange={(event) =>
            dispatch({ type: "rename", name: event.target.value })
          }
        />
      </div>
      <div className="field">
        <label htmlFor="dashboard-project">Project</label>
        <select
          id="dashboard-project"
          value={document.projectId ?? ""}
          onChange={(event) =>
            dispatch({
              type: "setProject",
              projectId: event.target.value || null,
            })
          }
        >
          <option value="">No project</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </div>

      <fieldset>
        <legend>Look</legend>
        <div className="field">
          <label htmlFor="dashboard-theme">Theme</label>
          <select
            id="dashboard-theme"
            value={themeChoice(settings)}
            onChange={(event) => update(parseThemeChoice(event.target.value))}
          >
            <optgroup label="Built-in">
              {themes.builtins.map((theme) => (
                <option key={theme.key} value={`builtin:${theme.key}`}>
                  {theme.name}
                </option>
              ))}
            </optgroup>
            {themes.custom.length > 0 ? (
              <optgroup label="Custom">
                {themes.custom.map((theme) => (
                  <option key={theme.id} value={`custom:${theme.id}`}>
                    {theme.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
          <p className="help">
            <a href={themesHref}>Make or edit custom themes</a>
          </p>
        </div>
        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={settings.accentColor !== null}
              onChange={(event) =>
                update({
                  accentColor: event.target.checked ? baseTokens.accent : null,
                })
              }
            />
            Brand accent colour
          </label>
          {settings.accentColor !== null ? (
            <div className="accent-row">
              <input
                type="color"
                aria-label="Accent colour picker"
                value={settings.accentColor}
                onChange={(event) =>
                  update({ accentColor: event.target.value.toLowerCase() })
                }
              />
              <input
                type="text"
                aria-label="Accent colour as #rrggbb"
                aria-describedby="accent-hint"
                value={accentText}
                maxLength={7}
                spellCheck={false}
                onChange={(event) => {
                  const value = event.target.value.trim();
                  setAccentText(value);
                  if (isHexColor(value.toLowerCase())) {
                    update({ accentColor: value.toLowerCase() });
                  }
                }}
              />
            </div>
          ) : null}
          {hint ? (
            <p
              id="accent-hint"
              className={`help contrast-${hint.level}`}
              role={hint.level === "fail" ? "alert" : undefined}
            >
              {hint.text}
            </p>
          ) : null}
        </div>
        <ImagePicker
          id="dashboard-logo"
          label="Logo"
          noneLabel="No logo"
          images={images}
          value={settings.logoImageId}
          onChange={(logoImageId) => update({ logoImageId })}
          onUpload={onUploadImage}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={settings.showHeader}
            onChange={(event) => update({ showHeader: event.target.checked })}
          />
          Header with name, slide name and clock
        </label>
      </fieldset>

      <fieldset>
        <legend>Rotation</legend>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.autoAdvance}
            onChange={(event) => update({ autoAdvance: event.target.checked })}
          />
          Advance through the slides
        </label>
        {!settings.autoAdvance ? (
          <p className="help">Screens show only the first visible slide.</p>
        ) : null}
        <div className="field">
          <label htmlFor="dashboard-duration">Default duration (seconds)</label>
          <input
            id="dashboard-duration"
            type="number"
            inputMode="numeric"
            min={SLIDE_SECONDS.min}
            max={SLIDE_SECONDS.max}
            value={
              Number.isNaN(settings.defaultSlideSeconds)
                ? ""
                : settings.defaultSlideSeconds
            }
            onChange={(event) =>
              update({
                defaultSlideSeconds: Math.round(Number(event.target.value)),
              })
            }
          />
        </div>
        <div className="field">
          <label htmlFor="dashboard-transition">Transition</label>
          <select
            id="dashboard-transition"
            value={settings.transition}
            onChange={(event) =>
              update({
                transition: event.target
                  .value as DashboardSettings["transition"],
              })
            }
          >
            <option value="fade">Fade</option>
            <option value="none">None</option>
          </select>
        </div>
      </fieldset>
    </section>
  );
}

export { WidgetPanel } from "./widget-panel";
