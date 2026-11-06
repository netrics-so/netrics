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
  type Locale,
  type ThemeTokens,
} from "@netrics/domain";

import { ThemePreview } from "@/components/theme-preview";
import { apiErrorMessage, deleteTheme, updateTheme } from "@/lib/api";
import type { WebTranslator } from "@/lib/i18n/catalogs";
import { useLocale, useT } from "@/lib/i18n/client";

const SCALE_NAMES: Record<ThemeFontScale, "normal" | "large" | "larger"> = {
  1: "normal",
  1.15: "large",
  1.3: "larger",
};

type EditorT = WebTranslator<"themes.editor">;
type TokensT = WebTranslator<"themes.tokens">;

function ratioText(ratio: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(ratio);
}

function pairName(check: ContrastCheck, t: EditorT, tokens: TokensT): string {
  const background = tokens(`${check.background}.label`);
  return t("pair", {
    foreground: tokens(`${check.foreground}.label`),
    // "Text on surface"; German nouns keep their capital ("Text auf Fläche").
    background: tokens.locale === "de" ? background : background.toLowerCase(),
  });
}

function ContrastBadge({ check }: { check: ContrastCheck }) {
  const locale = useLocale();
  const t = useT("themes.editor");
  return (
    <span className={`contrast-badge ${check.level}`}>
      {ratioText(check.ratio, locale)}:1 · {t(`levels.${check.level}`)}
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
  const t = useT("themes.editor");
  const tokenText = useT("themes.tokens");
  const common = useT("common");
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
    if (!window.confirm(t("confirmDelete", { name: theme.name }))) {
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
          <label htmlFor="theme-name">{t("name")}</label>
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
        <span className="muted">{t("basedOn", { name: baseName })}</span>
      </div>

      <div className="theme-editor-layout">
        <div className="theme-editor-side">
          <fieldset className="theme-tokens" disabled={disabled}>
            <legend>{t("colours")}</legend>
            {THEME_COLOR_TOKENS.map((token) => {
              const label = tokenText(`${token}.label`);
              const help = tokenText(`${token}.help`);
              const draft = drafts[token];
              const worst = tokenChecks(token).find(
                (check) => check.level === "fail",
              );
              return (
                <div className="theme-token" key={token}>
                  <input
                    type="color"
                    aria-label={t("colourPicker", { label })}
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
                        ? t("enterColour")
                        : worst
                          ? t("pairTooLow", {
                              pair: pairName(worst, t, tokenText),
                              ratio: ratioText(worst.ratio, locale),
                            })
                          : help}
                    </p>
                  </div>
                </div>
              );
            })}
            <div className="field">
              <label htmlFor="theme-font-scale">{t("textSize")}</label>
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
                    {t(`scales.${SCALE_NAMES[scale]}`, {
                      factor: new Intl.NumberFormat(locale, {
                        minimumFractionDigits: 1,
                      }).format(scale),
                    })}
                  </option>
                ))}
              </select>
              <p className="help">{t("textSizeHint")}</p>
            </div>
          </fieldset>
        </div>

        <div className="theme-editor-main">
          <ThemePreview tokens={tokens} />

          <section className="theme-contrast" aria-labelledby="contrast-title">
            <h2 id="contrast-title">{t("contrast")}</h2>
            <p className="muted">{t("contrastHint")}</p>
            <ul aria-live="polite">
              {checks.map((check) => (
                <li key={`${check.foreground}-${check.background}`}>
                  <span>{pairName(check, t, tokenText)}</span>
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
                {pending ? common("saving") : t("save")}
              </button>
              <button type="button" onClick={resetToBase} disabled={pending}>
                {t("resetTo", { name: baseName })}
              </button>
              <button
                type="button"
                className="danger"
                onClick={onDelete}
                disabled={pending}
              >
                {common("delete")}
              </button>
              {saved ? <span className="muted">{t("saved")}</span> : null}
            </div>
          ) : (
            <p className="muted">{t("readOnly")}</p>
          )}
          {failing ? (
            <div className="error" role="status">
              {t("raiseContrast")}
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
