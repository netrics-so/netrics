"use client";

import type {
  CustomApiPagination,
  CustomApiTestResponse,
  CustomApiWindow,
} from "@netrics/contracts";

import { DEFAULT_WINDOW } from "@/lib/custom-api-builder";

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
  const pagination = state.stream.pagination;
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

  return (
    <div className="custom-api-form">
      <fieldset className="field">
        <legend>{t("style")}</legend>
        <div className="custom-api-choices">
          {PAGINATION_TYPES.map((type) => (
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
          {text(
            "custom-api-offset-param",
            t("offsetParam"),
            pagination.offsetParam ?? "",
            (offsetParam) => setPagination({ ...pagination, offsetParam }),
          )}
          {text(
            "custom-api-limit-param",
            t("limitParam"),
            pagination.limitParam ?? "",
            (limitParam) => setPagination({ ...pagination, limitParam }),
          )}
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
          {text(
            "custom-api-cursor-param",
            t("cursorParam"),
            pagination.param ?? "",
            (param) => setPagination({ ...pagination, param }),
          )}
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
