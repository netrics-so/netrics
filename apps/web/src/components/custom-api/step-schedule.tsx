"use client";

import {
  CUSTOM_API_LIMITS,
  type CustomApiDefinition,
} from "@netrics/contracts";

import {
  confirmReadOnly,
  definitionHosts,
  definitionIssues,
  readOnlyRequests,
  type BuilderStep,
  type StreamMode,
} from "@/lib/custom-api-builder";
import { useLocale, useT } from "@/lib/i18n/client";

import { ReadOnlySave } from "./read-only-confirm";
import type { StepProps } from "./step-props";

const MODES: readonly StreamMode[] = [
  "upsert",
  "append",
  "replace_window",
  "snapshot",
];

/** Step 6: refresh, history, how records are stored, a summary, then save. */
export function StepSchedule({
  state,
  update,
  onGoTo,
  original,
}: StepProps & {
  onGoTo: (step: BuilderStep) => void;
  /** The saved document an edit saves against (as saveAndConnect does). */
  original?: CustomApiDefinition;
}) {
  const t = useT("customApi.review");
  const all = useT("customApi");
  const locale = useLocale();
  const window = state.stream.window;
  const issues = definitionIssues(state, original);
  const hosts = definitionHosts(state);
  const key = state.stream.fields
    .filter((f) => state.stream.keyFields.includes(f.id))
    .map((f) => f.name)
    .join(", ");
  return (
    <div className="custom-api-form">
      <div className="custom-api-pair">
        <div className="field">
          <label htmlFor="custom-api-refresh">{t("refresh")}</label>
          <input
            id="custom-api-refresh"
            type="number"
            min={CUSTOM_API_LIMITS.refreshMinutesMin}
            max={CUSTOM_API_LIMITS.refreshMinutesMax}
            value={state.defaults.refreshMinutes}
            onChange={(event) =>
              update((current) => ({
                ...current,
                defaults: {
                  ...current.defaults,
                  refreshMinutes: Number(event.target.value),
                },
              }))
            }
          />
          <p className="help">{t("refreshHelp")}</p>
        </div>
        {window.type !== "none" ? (
          <div className="field">
            <label htmlFor="custom-api-backfill">{t("backfill")}</label>
            <input
              id="custom-api-backfill"
              type="number"
              min={1}
              max={CUSTOM_API_LIMITS.backfillDaysMax}
              value={window.backfillDays}
              onChange={(event) =>
                update((current) =>
                  current.stream.window.type === "none"
                    ? current
                    : {
                        ...current,
                        stream: {
                          ...current.stream,
                          window: {
                            ...current.stream.window,
                            backfillDays: Number(event.target.value),
                          },
                        },
                      },
                )
              }
            />
          </div>
        ) : null}
      </div>
      <fieldset className="field">
        <legend>{t("mode")}</legend>
        {MODES.map((mode) => (
          <label className="checkbox custom-api-mode" key={mode}>
            <input
              type="radio"
              name="custom-api-mode"
              checked={state.stream.mode === mode}
              onChange={() =>
                update((current) => ({
                  ...current,
                  stream: { ...current.stream, mode },
                }))
              }
            />
            <span>
              {t(`modes.${mode}`)}
              <small className="help">{t(`modeHelp.${mode}`)}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <section className="custom-api-summary">
        <h3>{t("summary")}</h3>
        <p>
          {t("streamSummary", {
            name: state.stream.name,
            count: state.stream.fields.length,
            key: key || "–",
          })}
        </p>
        {hosts.length ? (
          <p>
            {t("hosts", {
              hosts: new Intl.ListFormat(locale, {
                type: "conjunction",
              }).format(hosts),
            })}
          </p>
        ) : null}
        {state.images?.hosts.length ? (
          <p>
            {t("imageHosts", {
              hosts: new Intl.ListFormat(locale, {
                type: "conjunction",
              }).format(state.images.hosts),
            })}
          </p>
        ) : null}
      </section>
      <ReadOnlySave
        requests={readOnlyRequests(state, original)}
        baseUrls={state.environments.map((e) => e.baseUrl.trim())}
        onConfirm={(streamKey, confirmed) =>
          update((current) =>
            confirmReadOnly(current, streamKey, confirmed, original),
          )
        }
      />
      {issues.length ? (
        <div className="error" role="alert">
          <p>{t("fixFirst")}</p>
          <ul>
            {issues.map((issue, index) => (
              <li key={index}>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => onGoTo(issue.step)}
                >
                  {all(`steps.${issue.step}`)}
                </button>
                : {all(`issues.codes.${issue.code}`)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
