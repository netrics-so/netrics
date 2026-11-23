"use client";

import { useState } from "react";

import type {
  CustomApiPagination,
  CustomApiTestResponse,
  CustomApiWindow,
} from "@netrics/contracts";

import {
  bodyLeafPaths,
  DEFAULT_WINDOW,
  endsAtArrayElement,
  pageValuePlacement,
  placePageValue,
  requestCheckIssues,
  setFirstPage,
  setPageBodyPath,
  setPageParam,
  type PageValue,
} from "@/lib/custom-api-builder";

const DEFAULT_WINDOW_STEP_DAYS =
  DEFAULT_WINDOW.type === "none" ? 7 : DEFAULT_WINDOW.stepDays;
const DEFAULT_BACKFILL_DAYS =
  DEFAULT_WINDOW.type === "none" ? 30 : DEFAULT_WINDOW.backfillDays;
import { useT } from "@/lib/i18n/client";

import { JsonTree } from "./json-tree";
import type { StepProps } from "./step-props";

export const PAGINATION_TYPES: readonly CustomApiPagination["type"][] = [
  "none",
  "page_number",
  "offset",
  "cursor",
  "next_url",
];

/** The settings a newly chosen paging style starts with. */
export function defaultPagination(
  type: CustomApiPagination["type"],
): CustomApiPagination {
  switch (type) {
    case "none":
      return { type };
    case "page_number":
      return { type, param: "page", start: 1 };
    case "offset":
      return { type, offsetParam: "offset", limitParam: "limit", limit: 100 };
    case "cursor":
      return { type, cursorPath: "", param: "cursor" };
    case "next_url":
      return { type, source: "body", path: "" };
  }
}

/** The pagination properties of each page value: URL parameter and body path. */
const PAGE_PROPERTIES = {
  cursor: { param: "param", bodyPath: "bodyPath" },
  offset: { param: "offsetParam", bodyPath: "offsetBodyPath" },
  limit: { param: "limitParam", bodyPath: "limitBodyPath" },
} as const;

/** Pages and records a paging test fetched. */
export function fetchedOf(test: CustomApiTestResponse): {
  pages: number;
  records: number;
} {
  const counted = test.log.every((entry) => entry.records !== null);
  return {
    pages: test.log.length,
    records: counted
      ? test.log.reduce((sum, entry) => sum + (entry.records ?? 0), 0)
      : test.rows.length,
  };
}

export const WINDOW_FORMATS = [
  "date",
  "timestamp",
  "unix_seconds",
  "unix_millis",
] as const;

/** Step 5: the paging style (tested with up to 5 pages) and the time window. */
export function StepPaging({
  state,
  update,
  pending,
  pagingTest,
  onTest,
}: StepProps & {
  pending: boolean;
  /** The last test with more than one page allowed, if any. */
  pagingTest: CustomApiTestResponse | null;
  onTest: () => void;
}) {
  const t = useT("customApi.paging");
  const all = useT("customApi");
  const pagination = state.stream.pagination;
  const post = state.stream.method === "POST";
  // Where a page value goes while neither a parameter nor a body path is
  // set yet (ADR 0030 §3: exactly one of the two).
  const [placing, setPlacing] = useState<
    Partial<Record<PageValue, "url" | "body">>
  >({});
  const window = state.stream.window;
  const body = state.lastTest?.response?.body;
  const setPagination = (next: CustomApiPagination) =>
    update((current) => ({
      ...current,
      stream: { ...current.stream, pagination: next },
    }));
  const setWindow = (next: CustomApiWindow) =>
    update((current) => ({
      ...current,
      stream: { ...current.stream, window: next },
    }));

  const text = (
    id: string,
    label: string,
    value: string,
    onChange: (value: string) => void,
  ) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={value}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
  const number = (
    id: string,
    label: string,
    value: number | undefined,
    onChange: (value: number | undefined) => void,
    min = 0,
  ) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        min={min}
        value={value ?? ""}
        onChange={(event) =>
          onChange(
            event.target.value === "" ? undefined : Number(event.target.value),
          )
        }
      />
    </div>
  );
  const pickedPath = (path: string, pick: (path: string) => void) =>
    body === undefined ? null : (
      <>
        <p className="help">
          {t("pickInTree")} <code>{path || t("notPicked")}</code>
        </p>
        <JsonTree
          key={`value-${state.lastTest?.response?.bytes}`}
          value={body}
          mode="value"
          recordPath={null}
          fieldPaths={new Set()}
          valuePath={path || null}
          onPickValue={pick}
        />
      </>
    );

  const fetched = pagingTest ? fetchedOf(pagingTest) : null;
  const leaves = post ? bodyLeafPaths(state) : [];
  // The SDK's paging rules, shown at the setting they are about.
  const checks = requestCheckIssues(state);
  const problemsAt = (property: string) => [
    ...new Set(
      checks
        .filter((issue) => issue.path.join(".") === `pagination.${property}`)
        .map((issue) => all(`issues.codes.${issue.code}`)),
    ),
  ];

  /** A URL parameter input; emptying it removes the parameter (never ""). */
  const paramInput = (value: PageValue, label: string) => {
    const owner = pagination as Record<string, unknown>;
    const property = PAGE_PROPERTIES[value].param;
    const problems = problemsAt(property);
    const id = `custom-api-${value}-param`;
    return (
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          value={(owner[property] as string | undefined) ?? ""}
          spellCheck={false}
          aria-invalid={problems.length > 0 || undefined}
          aria-describedby={problems.length ? `${id}-errors` : undefined}
          onChange={(event) =>
            setPagination(setPageParam(pagination, value, event.target.value))
          }
        />
        {problems.length ? (
          <p className="error" id={`${id}-errors`}>
            {problems.join(" ")}
          </p>
        ) : null}
      </div>
    );
  };

  /**
   * A POST stream's page value: a URL parameter or a value of the body
   * (ADR 0030 §3), never both. The URL input is shown only for "URL".
   */
  const placement = (value: PageValue, label: string) => {
    const placed =
      pageValuePlacement(pagination, value) ?? placing[value] ?? "url";
    const owner = pagination as Record<string, unknown>;
    const bodyProperty = PAGE_PROPERTIES[value].bodyPath;
    const bodyPath = (owner[bodyProperty] as string | undefined) ?? "";
    const problems = problemsAt(bodyProperty);
    const id = `custom-api-${value}-body-path`;
    const options =
      bodyPath && !leaves.includes(bodyPath) ? [bodyPath, ...leaves] : leaves;
    return (
      <fieldset className="field" data-testid={`custom-api-${value}-placement`}>
        <legend>{label}</legend>
        <div className="custom-api-choices">
          {(["url", "body"] as const).map((where) => (
            <label className="checkbox" key={where}>
              <input
                type="radio"
                name={`custom-api-${value}-placement`}
                checked={placed === where}
                onChange={() => {
                  setPlacing((current) => ({ ...current, [value]: where }));
                  setPagination(placePageValue(pagination, value, where));
                }}
              />
              {t(`placement.${where}`)}
            </label>
          ))}
        </div>
        {placed === "url" ? (
          paramInput(value, t("placement.param"))
        ) : (
          <div className="field">
            <label htmlFor={id}>{t("placement.bodyPath")}</label>
            <select
              id={id}
              value={bodyPath}
              aria-invalid={problems.length > 0 || undefined}
              aria-describedby={
                [`${id}-help`, problems.length ? `${id}-errors` : ""]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              onChange={(event) =>
                setPagination(
                  setPageBodyPath(pagination, value, event.target.value),
                )
              }
            >
              <option value="">{t("placement.choose")}</option>
              {options.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </select>
            <p className="help" id={`${id}-help`}>
              {t(
                state.stream.body.kind === "graphql"
                  ? "placement.bodyHelpGraphql"
                  : "placement.bodyHelp",
              )}
            </p>
            {problems.length ? (
              <p className="error" id={`${id}-errors`}>
                {problems.join(" ")}
              </p>
            ) : null}
          </div>
        )}
      </fieldset>
    );
  };

  return (
    <div className="custom-api-form">
      <fieldset className="field">
        <legend>{t("style")}</legend>
        <div className="custom-api-choices">
          {PAGINATION_TYPES.filter(
            // A POST request stays on its endpoint (ADR 0030 §2).
            (type) => !post || type !== "next_url",
          ).map((type) => (
            <label className="checkbox" key={type}>
              <input
                type="radio"
                name="custom-api-paging"
                checked={pagination.type === type}
                onChange={() => setPagination(defaultPagination(type))}
              />
              {t(`styles.${type}`)}
            </label>
          ))}
        </div>
        {post ? <p className="help">{t("postNoNextUrl")}</p> : null}
      </fieldset>

      {pagination.type === "page_number" ? (
        <div className="custom-api-pair">
          {text(
            "custom-api-page-param",
            t("param"),
            pagination.param,
            (param) => setPagination({ ...pagination, param }),
          )}
          <div className="field">
            <label htmlFor="custom-api-page-start">{t("start")}</label>
            <select
              id="custom-api-page-start"
              value={pagination.start}
              onChange={(event) =>
                setPagination({
                  ...pagination,
                  start: event.target.value === "0" ? 0 : 1,
                })
              }
            >
              <option value="1">1</option>
              <option value="0">0</option>
            </select>
          </div>
          {text(
            "custom-api-page-size-param",
            t("sizeParam"),
            pagination.sizeParam ?? "",
            (sizeParam) => {
              const { sizeParam: _old, ...rest } = pagination;
              setPagination(sizeParam ? { ...rest, sizeParam } : rest);
            },
          )}
          {number(
            "custom-api-page-size",
            t("size"),
            pagination.size,
            (size) => {
              const { size: _old, ...rest } = pagination;
              setPagination(size ? { ...rest, size } : rest);
            },
            1,
          )}
        </div>
      ) : null}

      {pagination.type === "offset" ? (
        <div className="custom-api-pair">
          {post
            ? placement("offset", t("offsetParam"))
            : paramInput("offset", t("offsetParam"))}
          {post
            ? placement("limit", t("limitParam"))
            : paramInput("limit", t("limitParam"))}
          {number(
            "custom-api-limit",
            t("limit"),
            pagination.limit,
            (limit) => setPagination({ ...pagination, limit: limit ?? 0 }),
            1,
          )}
        </div>
      ) : null}

      {pagination.type === "cursor" ? (
        <>
          {post
            ? placement("cursor", t("cursorParam"))
            : paramInput("cursor", t("cursorParam"))}
          {post && pagination.bodyPath !== undefined ? (
            <fieldset className="field">
              <legend>{t("firstPage.title")}</legend>
              <div className="custom-api-choices">
                {(["null", "omit"] as const).map((firstPage) => {
                  const disabled =
                    firstPage === "omit" &&
                    endsAtArrayElement(pagination.bodyPath ?? "");
                  return (
                    <label className="checkbox" key={firstPage}>
                      <input
                        type="radio"
                        name="custom-api-first-page"
                        checked={(pagination.firstPage ?? "null") === firstPage}
                        disabled={disabled}
                        aria-describedby="custom-api-first-page-help"
                        onChange={() =>
                          setPagination(setFirstPage(pagination, firstPage))
                        }
                      />
                      {t(`firstPage.${firstPage}`)}
                    </label>
                  );
                })}
              </div>
              <p className="help" id="custom-api-first-page-help">
                {t("firstPage.help")}
              </p>
              {problemsAt("firstPage").length ? (
                <p className="error">{problemsAt("firstPage").join(" ")}</p>
              ) : null}
            </fieldset>
          ) : null}
          <div className="field">
            <span className="custom-api-label">{t("cursorPath")}</span>
            {pickedPath(pagination.cursorPath, (cursorPath) =>
              setPagination({ ...pagination, cursorPath }),
            )}
          </div>
        </>
      ) : null}

      {pagination.type === "next_url" ? (
        <>
          <fieldset className="field">
            <legend>{t("nextSource")}</legend>
            <div className="custom-api-choices">
              <label className="checkbox">
                <input
                  type="radio"
                  name="custom-api-next-source"
                  checked={pagination.source === "body"}
                  onChange={() =>
                    setPagination({
                      type: "next_url",
                      source: "body",
                      path: "",
                    })
                  }
                />
                {t("nextBody")}
              </label>
              <label className="checkbox">
                <input
                  type="radio"
                  name="custom-api-next-source"
                  checked={pagination.source === "link_header"}
                  onChange={() =>
                    setPagination({ type: "next_url", source: "link_header" })
                  }
                />
                {t("nextHeader")}
              </label>
            </div>
          </fieldset>
          {pagination.source === "body" ? (
            <div className="field">
              <span className="custom-api-label">{t("nextPath")}</span>
              {pickedPath(pagination.path, (path) =>
                setPagination({ ...pagination, path }),
              )}
            </div>
          ) : null}
        </>
      ) : null}

      <div className="custom-api-actions">
        <button type="button" disabled={pending} onClick={onTest}>
          {t("test")}
        </button>
        {fetched ? (
          <span className="custom-api-fetched" role="status">
            {t("fetched", fetched)}
          </span>
        ) : null}
      </div>

      <fieldset className="field">
        <legend>{t("window.title")}</legend>
        <div className="custom-api-choices">
          {(["none", "date", "timestamp"] as const).map((type) => (
            <label className="checkbox" key={type}>
              <input
                type="radio"
                name="custom-api-window"
                checked={window.type === type}
                onChange={() =>
                  setWindow(
                    type === "none"
                      ? { type }
                      : window.type === "none"
                        ? {
                            type,
                            stepDays: DEFAULT_WINDOW_STEP_DAYS,
                            lookbackDays: 0,
                            backfillDays: DEFAULT_BACKFILL_DAYS,
                            paramFormat: type === "date" ? "date" : "timestamp",
                            endInclusive: false,
                          }
                        : { ...window, type },
                  )
                }
              />
              {t(`window.${type}`)}
            </label>
          ))}
        </div>
      </fieldset>
      {window.type !== "none" ? (
        <div className="custom-api-pair">
          {number(
            "custom-api-step-days",
            t("window.stepDays"),
            window.stepDays,
            (stepDays) => setWindow({ ...window, stepDays: stepDays ?? 0 }),
            1,
          )}
          {number(
            "custom-api-lookback-days",
            t("window.lookbackDays"),
            window.lookbackDays,
            (lookbackDays) =>
              setWindow({ ...window, lookbackDays: lookbackDays ?? 0 }),
          )}
          <div className="field">
            <label htmlFor="custom-api-window-format">
              {t("window.format")}
            </label>
            <select
              id="custom-api-window-format"
              value={window.paramFormat}
              onChange={(event) =>
                setWindow({
                  ...window,
                  paramFormat: event.target
                    .value as (typeof WINDOW_FORMATS)[number],
                })
              }
            >
              {WINDOW_FORMATS.map((format) => (
                <option key={format} value={format}>
                  {t(`window.formats.${format}`)}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}
    </div>
  );
}
