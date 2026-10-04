"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";

import type { WorkspaceTheme } from "@netrics/contracts";
import {
  BUILTIN_THEMES,
  THEME_COLOR_TOKENS,
  THEME_FONT_SCALES,
  checkThemeContrast,
  isHexColor,
  type ContrastCheck,
  type ThemeColorToken,
  type ThemeFontScale,
  type ThemeTokens,
} from "@netrics/domain";

import { ThemePreview } from "@/components/theme-preview";
import { apiErrorMessage, deleteTheme, updateTheme } from "@/lib/api";
import { useLocale } from "@/lib/i18n/client";

const TOKEN_LABELS: Record<ThemeColorToken, [string, string]> = {
  background: ["Background", "The canvas behind the widgets"],
  surface: ["Surface", "Widget background"],
  border: ["Border", "Widget border"],
  text: ["Text", "Values and headings"],
  label: ["Label", "Widget titles"],
  muted: ["Muted", "Secondary lines and axes"],
  accent: ["Accent", "Highlights, the last point, the clock"],
  up: ["Up", "Change in the good direction"],
  down: ["Down", "Change in the bad direction"],
  warning: ["Warning", "Stale data and failures"],
  chartLine: ["Chart line", "Sparklines and line charts"],
  chartFill: ["Chart fill", "Bars and the area under lines"],
};

const SCALE_LABELS: Record<ThemeFontScale, string> = {
  1: "Normal (1.0×)",
  1.15: "Large (1.15×)",
  1.3: "Larger (1.3×)",
};

function pairName(check: ContrastCheck): string {
  return `${TOKEN_LABELS[check.foreground][0]} on ${TOKEN_LABELS[
    check.background
  ][0].toLowerCase()}`;
}

const LEVEL_TEXT = {
  pass: "AA",
  warn: "Below AA",
  fail: "Too low",
} as const;

function ContrastBadge({ check }: { check: ContrastCheck }) {
  return (
    <span className={`contrast-badge ${check.level}`}>
      {check.ratio.toFixed(2)}:1 · {LEVEL_TEXT[check.level]}
    </span>
  );
}

export function ThemeEditor({
  workspaceId,
  theme,
  baseName,
  canEdit,
}: {
  workspaceId: string;
  theme: WorkspaceTheme;
  baseName: string;
  canEdit: boolean;
}) {
  const locale = useLocale();
  const router = useRouter();
  const [name, setName] = useState(theme.name);
  const [tokens, setTokens] = useState<ThemeTokens>(
    theme.tokens as ThemeTokens,
  );
  // What the text fields show while a colour is being typed.
  const [drafts, setDrafts] = useState<
    Partial<Record<ThemeColorToken, string>>
  >({});
  const [version, setVersion] = useState(theme.version);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const checks = useMemo(() => checkThemeContrast(tokens), [tokens]);
  const failing = checks.some((check) => check.level === "fail");
  const invalid = Object.keys(drafts).length > 0;
  const tokenChecks = (token: ThemeColorToken) =>
    checks.filter(
      (check) => check.foreground === token || check.background === token,
    );

  function setColor(token: ThemeColorToken, value: string) {
    setSaved(false);
    const normalized = value.trim().toLowerCase();
    if (isHexColor(normalized)) {
      setTokens((current) => ({ ...current, [token]: normalized }));
      setDrafts(({ [token]: _dropped, ...rest }) => rest);
    } else {
      setDrafts((current) => ({ ...current, [token]: value }));
    }
  }

  function resetToBase() {
    setSaved(false);
    setDrafts({});
    setTokens(BUILTIN_THEMES[theme.base].tokens);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      const { theme: updated } = await updateTheme(workspaceId, theme.id, {
        version,
        name,
        tokens,
      });
      setVersion(updated.version);
      setTokens(updated.tokens as ThemeTokens);
      setSaved(true);
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(false);
    }
  }

  async function onDelete() {
    if (!window.confirm(`Delete the theme "${theme.name}"?`)) {
      return;
    }
    setError(null);
    setPending(true);
    try {
      await deleteTheme(workspaceId, theme.id);
      router.push(`/workspaces/${workspaceId}/settings/themes`);
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
      setPending(false);
    }
  }

  const disabled = !canEdit || pending;

  return (
    <form className="theme-editor" onSubmit={onSubmit}>
      <div className="dashboard-header">
        <div className="field">
          <label htmlFor="theme-name">Theme name</label>
          <input
            id="theme-name"
            className="dashboard-name-input"
            value={name}
            maxLength={100}
            required
            disabled={disabled}
            onChange={(event) => {
              setSaved(false);
              setName(event.target.value);
            }}
          />
        </div>
        <span className="muted">Based on {baseName}</span>
      </div>

      <div className="theme-editor-layout">
        <div className="theme-editor-side">
          <fieldset className="theme-tokens" disabled={disabled}>
            <legend>Colours</legend>
            {THEME_COLOR_TOKENS.map((token) => {
              const [label, help] = TOKEN_LABELS[token];
              const draft = drafts[token];
              const worst = tokenChecks(token).find(
                (check) => check.level === "fail",
              );
              return (
                <div className="theme-token" key={token}>
                  <input
                    type="color"
                    aria-label={`${label} colour picker`}
                    value={tokens[token]}
                    onChange={(event) => setColor(token, event.target.value)}
                  />
                  <div className="field">
                    <label htmlFor={`token-${token}`}>{label}</label>
                    <input
                      id={`token-${token}`}
                      className="theme-hex"
                      value={draft ?? tokens[token]}
                      spellCheck={false}
                      aria-invalid={draft !== undefined || worst !== undefined}
                      aria-describedby={`token-${token}-help`}
                      onChange={(event) => setColor(token, event.target.value)}
                    />
                    <p className="help" id={`token-${token}-help`}>
                      {draft !== undefined
                        ? "Enter a colour like #7aa2f7."
                        : worst
                          ? `${pairName(worst)} is ${worst.ratio.toFixed(2)}:1, below 3:1.`
                          : help}
                    </p>
                  </div>
                </div>
              );
            })}
            <div className="field">
              <label htmlFor="theme-font-scale">Text size</label>
              <select
                id="theme-font-scale"
                value={String(tokens.fontScale)}
                onChange={(event) => {
                  setSaved(false);
                  setTokens((current) => ({
                    ...current,
                    fontScale: Number(event.target.value) as ThemeFontScale,
                  }));
                }}
              >
                {THEME_FONT_SCALES.map((scale) => (
                  <option key={scale} value={String(scale)}>
                    {SCALE_LABELS[scale]}
                  </option>
                ))}
              </select>
              <p className="help">
                Scales every text up; it never goes below the TV minimums.
              </p>
            </div>
          </fieldset>
        </div>

        <div className="theme-editor-main">
          <ThemePreview tokens={tokens} />

          <section className="theme-contrast" aria-labelledby="contrast-title">
            <h2 id="contrast-title">Contrast</h2>
            <p className="muted">
              TVs are read from a distance. Below 4.5:1 is a warning; below 3:1
              the theme cannot be saved.
            </p>
            <ul aria-live="polite">
              {checks.map((check) => (
                <li key={`${check.foreground}-${check.background}`}>
                  <span>{pairName(check)}</span>
                  <ContrastBadge check={check} />
                </li>
              ))}
            </ul>
          </section>

          {canEdit ? (
            <div className="actions">
              <button
                type="submit"
                className="primary"
                disabled={pending || failing || invalid || !name.trim()}
              >
                {pending ? "Saving…" : "Save theme"}
              </button>
              <button type="button" onClick={resetToBase} disabled={pending}>
                Reset to {baseName}
              </button>
              <button
                type="button"
                className="danger"
                onClick={onDelete}
                disabled={pending}
              >
                Delete
              </button>
              {saved ? <span className="muted">Saved.</span> : null}
            </div>
          ) : (
            <p className="muted">
              Your role can view themes but not change them.
            </p>
          )}
          {failing ? (
            <div className="error" role="status">
              Raise the contrast of the pairs marked &ldquo;Too low&rdquo; to
              save.
            </div>
          ) : null}
          {error ? (
            <div className="error" role="alert">
              {error}
            </div>
          ) : null}
        </div>
      </div>
    </form>
  );
}
