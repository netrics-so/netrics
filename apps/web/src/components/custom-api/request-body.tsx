"use client";

import {
  bodyProblems,
  graphqlCheck,
  requestCheckIssues,
  setBodyKind,
  setMethod,
  withBody,
  type BodyKind,
  type RequestMethod,
} from "@/lib/custom-api-builder";
import { useT } from "@/lib/i18n/client";

import type { StepProps } from "./step-props";

type Track = (event: {
  currentTarget: HTMLInputElement | HTMLTextAreaElement;
}) => void;

const METHODS: readonly RequestMethod[] = ["GET", "POST"];
const KINDS: readonly BodyKind[] = ["json", "graphql"];

/**
 * The method and, for POST, the body (ADR 0030): a JSON body with
 * placeholder hints, or a GraphQL query and its variables with the
 * read-only check shown as it is typed. The checks are the SDK's (the
 * server runs the same ones before a test is sent).
 */
export function RequestBody({
  state,
  update,
  onTrack,
}: StepProps & {
  /** Where "Insert value" puts a placeholder. */
  onTrack: (kind: "json" | "variables") => Track;
}) {
  const t = useT("customApi.request");
  const all = useT("customApi");
  const { method, body } = state.stream;
  const problems = bodyProblems(state);
  const graphql = graphqlCheck(state);
  // The SDK's rules on the body's values (placeholders), by editor field.
  const valueIssues = (prefix: string) => [
    ...new Set(
      method === "POST"
        ? requestCheckIssues(state)
            .filter((issue) => issue.path.join(".").startsWith(prefix))
            .map((issue) => issue.code)
        : [],
    ),
  ];
  const jsonIssues = valueIssues("request.body.value");
  const variableIssues = valueIssues("request.body.variables");

  const errors = (id: string, messages: string[]) =>
    messages.length ? (
      <ul className="error custom-api-field-errors" id={id}>
        {messages.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    ) : null;
  const describedBy = (...ids: (string | false)[]) =>
    ids.filter(Boolean).join(" ") || undefined;

  const jsonErrors = [
    ...(problems.json ? [t(`bodyErrors.${problems.json}`)] : []),
    ...jsonIssues.map((code) => all(`issues.codes.${code}`)),
  ];
  const queryErrors = problems.query ? [t(`bodyErrors.${problems.query}`)] : [];
  const variablesErrors = [
    ...(problems.variables
      ? [t(`bodyErrors.variables.${problems.variables}`)]
      : []),
    ...variableIssues.map((code) => all(`issues.codes.${code}`)),
  ];

  return (
    <>
      <fieldset className="field">
        <legend>{t("method")}</legend>
        <div className="custom-api-choices">
          {METHODS.map((entry) => (
            <label className="checkbox" key={entry}>
              <input
                type="radio"
                name="custom-api-method"
                value={entry}
                checked={method === entry}
                onChange={() => update((current) => setMethod(current, entry))}
              />
              {entry}
            </label>
          ))}
        </div>
        <p className="help">{t(method === "POST" ? "postHelp" : "getHelp")}</p>
      </fieldset>
      {method === "POST" ? (
        <>
          <fieldset className="field">
            <legend>{t("bodyKind")}</legend>
            <div className="custom-api-choices">
              {KINDS.map((kind) => (
                <label className="checkbox" key={kind}>
                  <input
                    type="radio"
                    name="custom-api-body-kind"
                    value={kind}
                    checked={body.kind === kind}
                    onChange={() =>
                      update((current) => setBodyKind(current, kind))
                    }
                  />
                  {t(`bodyKinds.${kind}`)}
                </label>
              ))}
            </div>
          </fieldset>
          {body.kind === "json" ? (
            <div className="field">
              <label htmlFor="custom-api-body-json">{t("bodyJson")}</label>
              <textarea
                id="custom-api-body-json"
                className="custom-api-code"
                rows={8}
                spellCheck={false}
                value={body.json}
                aria-invalid={jsonErrors.length > 0 || undefined}
                aria-describedby={describedBy(
                  "custom-api-body-json-help",
                  jsonErrors.length > 0 && "custom-api-body-json-errors",
                )}
                onFocus={onTrack("json")}
                onSelect={onTrack("json")}
                onKeyUp={onTrack("json")}
                onChange={(event) =>
                  update((current) =>
                    withBody(current, { json: event.target.value }),
                  )
                }
              />
              <div className="help" id="custom-api-body-json-help">
                <p>{t("bodyHelp")}</p>
                <p>{t("bodyNoPage")}</p>
                <p>{t("jsonReadOnly")}</p>
              </div>
              {errors("custom-api-body-json-errors", jsonErrors)}
            </div>
          ) : (
            <>
              <div className="field">
                <label htmlFor="custom-api-graphql-query">
                  {t("graphqlQuery")}
                </label>
                <textarea
                  id="custom-api-graphql-query"
                  className="custom-api-code"
                  rows={8}
                  spellCheck={false}
                  value={body.query}
                  aria-invalid={
                    queryErrors.length > 0 || graphql?.ok === false || undefined
                  }
                  aria-describedby={describedBy(
                    "custom-api-graphql-query-help",
                    "custom-api-graphql-check",
                    queryErrors.length > 0 && "custom-api-graphql-query-errors",
                  )}
                  onChange={(event) =>
                    update((current) =>
                      withBody(current, { query: event.target.value }),
                    )
                  }
                />
                <p className="help" id="custom-api-graphql-query-help">
                  {t("graphqlQueryHelp")}
                </p>
                <p
                  id="custom-api-graphql-check"
                  role="status"
                  data-testid="custom-api-graphql-check"
                  className={
                    graphql === null
                      ? "help"
                      : graphql.ok
                        ? "custom-api-check-ok"
                        : "error"
                  }
                >
                  {graphql === null
                    ? null
                    : graphql.ok
                      ? t("graphqlCheck.ok")
                      : t(`graphqlCheck.${graphql.problem}`)}
                </p>
                {errors("custom-api-graphql-query-errors", queryErrors)}
              </div>
              <div className="field">
                <label htmlFor="custom-api-graphql-variables">
                  {t("graphqlVariables")}
                </label>
                <textarea
                  id="custom-api-graphql-variables"
                  className="custom-api-code"
                  rows={5}
                  spellCheck={false}
                  value={body.variables}
                  aria-invalid={variablesErrors.length > 0 || undefined}
                  aria-describedby={describedBy(
                    "custom-api-graphql-variables-help",
                    variablesErrors.length > 0 &&
                      "custom-api-graphql-variables-errors",
                  )}
                  onFocus={onTrack("variables")}
                  onSelect={onTrack("variables")}
                  onKeyUp={onTrack("variables")}
                  onChange={(event) =>
                    update((current) =>
                      withBody(current, { variables: event.target.value }),
                    )
                  }
                />
                <div className="help" id="custom-api-graphql-variables-help">
                  <p>{t("graphqlVariablesHelp")}</p>
                  <p>{t("bodyNoPage")}</p>
                </div>
                {errors("custom-api-graphql-variables-errors", variablesErrors)}
              </div>
            </>
          )}
        </>
      ) : null}
    </>
  );
}
