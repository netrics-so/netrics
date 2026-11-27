"use client";

import { useRef, useState } from "react";

import {
  availablePlaceholders,
  bodyPlaceholders,
  variableIdFromLabel,
  withBody,
  withRequest,
  type BuilderState,
  type KeyValue,
} from "@/lib/custom-api-builder";
import { useT } from "@/lib/i18n/client";

import { RequestBody } from "./request-body";
import { enteredSecrets, SecretInputs } from "./step-login";
import type { StepProps } from "./step-props";

/** Where "Insert value" puts a placeholder: the last focused template input. */
type Target =
  | { kind: "path" }
  | { kind: "query" | "headers"; index: number }
  | { kind: "json" }
  | { kind: "variables" };

/**
 * The target "Insert value" uses now: the last focused input while it is
 * shown, else the path (#886 review). A body editor hidden by GET or by
 * the other body kind, or a removed row, is never edited unseen.
 */
export function insertionTarget(target: Target, state: BuilderState): Target {
  const { method, body } = state.stream;
  switch (target.kind) {
    case "path":
      return target;
    case "json":
    case "variables": {
      const kind = target.kind === "json" ? "json" : "graphql";
      return method === "POST" && body.kind === kind
        ? target
        : { kind: "path" };
    }
    default:
      return state.stream[target.kind][target.index]
        ? target
        : { kind: "path" };
  }
}

/**
 * The placeholders "Insert value" offers for where it inserts (#887): a
 * body takes no page values (ADR 0030 §1), nor does a POST path, which
 * stays on its endpoint between pages; the URL parameters and headers
 * take every one.
 */
export function placeholdersFor(target: Target, state: BuilderState): string[] {
  const shown = insertionTarget(target, state);
  return shown.kind === "json" ||
    shown.kind === "variables" ||
    (shown.kind === "path" && state.stream.method === "POST")
    ? bodyPlaceholders(state)
    : availablePlaceholders(state);
}

/** The help under "Insert value", for where it inserts. */
function placeholderHelpKey(target: Target, state: BuilderState) {
  const shown = insertionTarget(target, state);
  if (shown.kind === "json" || shown.kind === "variables")
    return "placeholderBodyHelp";
  return shown.kind === "path" && state.stream.method === "POST"
    ? "placeholderPostPathHelp"
    : "placeholderHelp";
}

function insertAt(text: string, value: string, start: number, end: number) {
  return text.slice(0, start) + value + text.slice(end);
}

/** Step 3: path, query parameters, headers, connection values, test. */
export function StepRequest({
  state,
  update,
  pending,
  values: secretValues,
  onValueChange,
  savedVariableIds = new Set(),
  onSaveSecrets,
  onTest,
}: StepProps & {
  pending: boolean;
  /** Secrets typed but not saved yet (kept by the builder, never stored). */
  values: Readonly<Record<string, string>>;
  onValueChange: (name: string, value: string | undefined) => void;
  /** Variables of the saved definition: their ids stay (connections use them). */
  savedVariableIds?: ReadonlySet<string>;
  onSaveSecrets: (secrets: Record<string, string>) => Promise<boolean>;
  onTest: () => void;
}) {
  const t = useT("customApi.request");
  const login = useT("customApi.login");
  const cursor = useRef<{ target: Target; start: number; end: number }>({
    target: { kind: "path" },
    start: state.stream.path.length,
    end: state.stream.path.length,
  });
  // The list follows the insertion target (the ref doesn't re-render).
  const [focused, setFocused] = useState<Target>(cursor.current.target);
  const placeholders = placeholdersFor(focused, state);
  const track =
    (target: Target) =>
    (event: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
      const input = event.currentTarget;
      cursor.current = {
        target,
        start: input.selectionStart ?? input.value.length,
        end: input.selectionEnd ?? input.value.length,
      };
      setFocused((current) =>
        current.kind === target.kind &&
        ("index" in current ? current.index : -1) ===
          ("index" in target ? target.index : -1)
          ? current
          : target,
      );
    };
  const setRequest = (
    patch: Partial<Pick<BuilderState["stream"], "path" | "query" | "headers">>,
  ) => update((current) => withRequest(current, patch));

  const insert = (name: string) => {
    const text = `{{${name}}}`;
    // A hidden editor is no target: the placeholder goes to the path's end.
    const kept = insertionTarget(cursor.current.target, state);
    const { target, start, end } =
      kept === cursor.current.target
        ? cursor.current
        : {
            target: kept,
            start: state.stream.path.length,
            end: state.stream.path.length,
          };
    if (target !== cursor.current.target) setFocused(target);
    update((current) => {
      if (target.kind === "json" || target.kind === "variables") {
        const typed = current.stream.body[target.kind];
        const at = Math.min(start, typed.length);
        return withBody(current, {
          [target.kind]: insertAt(typed, text, at, Math.min(end, typed.length)),
        });
      }
      if (target.kind === "path") {
        const path = current.stream.path;
        const at = Math.min(start, path.length);
        return withRequest(current, {
          path: insertAt(path, text, at, Math.min(end, path.length)),
        });
      }
      const rows = current.stream[target.kind];
      const row = rows[target.index];
      if (!row) return current;
      const at = Math.min(start, row.value.length);
      const next = rows.map((r, i) =>
        i === target.index
          ? {
              ...r,
              value: insertAt(r.value, text, at, Math.min(end, r.value.length)),
            }
          : r,
      );
      return withRequest(current, { [target.kind]: next });
    });
    cursor.current = {
      target,
      start: start + text.length,
      end: start + text.length,
    };
  };

  const rowsEditor = (kind: "query" | "headers") => {
    const rows: KeyValue[] = state.stream[kind];
    const set = (next: KeyValue[]) => setRequest({ [kind]: next });
    return (
      <fieldset className="field">
        <legend>{t(kind)}</legend>
        {rows.map((row, index) => (
          <div className="custom-api-kv" key={index}>
            <input
              aria-label={`${t(kind)} ${index + 1}: ${t("name")}`}
              placeholder={t("name")}
              value={row.key}
              spellCheck={false}
              onChange={(event) =>
                set(
                  rows.map((r, i) =>
                    i === index ? { ...r, key: event.target.value } : r,
                  ),
                )
              }
            />
            <input
              aria-label={`${t(kind)} ${index + 1}: ${t("value")}`}
              placeholder={t("value")}
              value={row.value}
              spellCheck={false}
              onFocus={track({ kind, index })}
              onSelect={track({ kind, index })}
              onKeyUp={track({ kind, index })}
              onChange={(event) =>
                set(
                  rows.map((r, i) =>
                    i === index ? { ...r, value: event.target.value } : r,
                  ),
                )
              }
            />
            <button
              type="button"
              className="link-button"
              onClick={() => set(rows.filter((_, i) => i !== index))}
            >
              {t("remove")}
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => set([...rows, { key: "", value: "" }])}
        >
          {t("addRow")}
        </button>
      </fieldset>
    );
  };

  const secretEntries = state.variables
    .filter((v) => v.secret && v.id)
    .map((v) => ({ name: v.id, label: v.label || v.id }));
  const entered = enteredSecrets(
    Object.fromEntries(
      secretEntries
        .filter((e) => secretValues[e.name] !== undefined)
        .map((e) => [e.name, secretValues[e.name]!]),
    ),
  );

  return (
    <div className="custom-api-form">
      <div className="field">
        <label htmlFor="custom-api-path">{t("path")}</label>
        <input
          id="custom-api-path"
          value={state.stream.path}
          spellCheck={false}
          onFocus={track({ kind: "path" })}
          onSelect={track({ kind: "path" })}
          onKeyUp={track({ kind: "path" })}
          onChange={(event) => setRequest({ path: event.target.value })}
        />
      </div>
      {rowsEditor("query")}
      {rowsEditor("headers")}
      <RequestBody
        state={state}
        update={update}
        onTrack={(kind) => track({ kind })}
      />
      <div className="field custom-api-insert">
        <label htmlFor="custom-api-insert">{t("insert")}</label>
        <select
          id="custom-api-insert"
          value=""
          onChange={(event) => {
            if (event.target.value) insert(event.target.value);
          }}
        >
          <option value="">…</option>
          {placeholders.map((name) => (
            <option key={name} value={name}>{`{{${name}}}`}</option>
          ))}
        </select>
        <p className="help">{t(placeholderHelpKey(focused, state))}</p>
      </div>

      <fieldset className="field">
        <legend>{t("variables")}</legend>
        <p className="help">{t("variablesHelp")}</p>
        {state.variables.map((variable, index) => (
          <div className="custom-api-variable" key={index}>
            <input
              aria-label={`${t("variables")} ${index + 1}: ${t("label")}`}
              placeholder={t("label")}
              value={variable.label}
              onChange={(event) => {
                const label = event.target.value;
                update((current) => {
                  const taken = new Set(
                    current.variables
                      .filter((_, i) => i !== index)
                      .map((v) => v.id),
                  );
                  return {
                    ...current,
                    variables: current.variables.map((v, i) =>
                      i === index
                        ? {
                            ...v,
                            label,
                            // A saved variable keeps its id: connections
                            // hold their values under it.
                            id: savedVariableIds.has(v.id)
                              ? v.id
                              : variableIdFromLabel(label, taken),
                          }
                        : v,
                    ),
                  };
                });
              }}
            />
            <code>{variable.id ? `{{${variable.id}}}` : ""}</code>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={variable.secret}
                onChange={(event) =>
                  update((current) => ({
                    ...current,
                    variables: current.variables.map((v, i) =>
                      i === index
                        ? { ...v, secret: event.target.checked, value: "" }
                        : v,
                    ),
                  }))
                }
              />
              {t("secret")}
            </label>
            {variable.secret ? null : (
              <input
                aria-label={`${variable.label || t("variables")}: ${t("testValue")}`}
                placeholder={t("testValue")}
                value={variable.value}
                onChange={(event) =>
                  update((current) => ({
                    ...current,
                    variables: current.variables.map((v, i) =>
                      i === index ? { ...v, value: event.target.value } : v,
                    ),
                  }))
                }
              />
            )}
            <button
              type="button"
              className="link-button"
              onClick={() =>
                update((current) => ({
                  ...current,
                  variables: current.variables.filter((_, i) => i !== index),
                }))
              }
            >
              {t("remove")}
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            update((current) => ({
              ...current,
              variables: [
                ...current.variables,
                { id: "", label: "", secret: false, value: "" },
              ],
            }))
          }
        >
          {t("addRow")}
        </button>
        {secretEntries.length ? (
          <>
            <SecretInputs
              entries={secretEntries}
              stored={state.secretsSet}
              values={secretValues}
              idPrefix="custom-api-secret-variable"
              onChange={onValueChange}
            />
            <button
              type="button"
              disabled={pending || !entered}
              onClick={async () => {
                if (entered) await onSaveSecrets(entered);
              }}
            >
              {login("save")}
            </button>
          </>
        ) : null}
      </fieldset>

      <div className="custom-api-actions">
        <button
          type="button"
          className="primary"
          disabled={pending}
          onClick={onTest}
        >
          {t("send")}
        </button>
      </div>
    </div>
  );
}
