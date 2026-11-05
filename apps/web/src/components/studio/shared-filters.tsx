"use client";
import { useEffect, useId, useState } from "react";
import type {
  DashboardDataFilter,
  DashboardFilterValue,
} from "@netrics/domain";
import { loadDimensionValues } from "@/lib/dashboard-data-api";
import { enteredValue } from "@/lib/data-editing";
import { useT } from "@/lib/i18n/client";
export function DashboardFilterInput({
  filter,
  workspaceId,
  initialBrowse = false,
  value,
  onChange,
}: {
  filter: DashboardDataFilter;
  workspaceId?: string;
  initialBrowse?: boolean;
  value: DashboardFilterValue;
  onChange: (value: DashboardFilterValue) => void;
}) {
  const id = useId(),
    t = useT("data.dashboard"),
    [text, setText] = useState(""),
    [error, setError] = useState(false);
  const [browse, setBrowse] = useState(initialBrowse),
    [search, setSearch] = useState(""),
    [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0);
  const [choices, setChoices] = useState<{
      values: unknown[];
      total: number;
    } | null>(null),
    [choicesError, setChoicesError] = useState(false),
    [choicesLoading, setChoicesLoading] = useState(false);
  const mapping = filter.mappings[0];
  useEffect(() => {
    if (!browse || !workspaceId || !mapping || filter.mode !== "values") return;
    let alive = true;
    setChoices(null);
    setChoicesError(false);
    setChoicesLoading(true);
    const timer = setTimeout(() => {
      loadDimensionValues(
        workspaceId,
        mapping.modelId,
        mapping.dimensionId,
        search,
        offset,
      )
        .then((response) => {
          if (alive) setChoices(response);
        })
        .catch(() => {
          if (alive) setChoicesError(true);
        })
        .finally(() => {
          if (alive) setChoicesLoading(false);
        });
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [
    browse,
    workspaceId,
    mapping?.modelId,
    mapping?.dimensionId,
    filter.mode,
    search,
    offset,
    revision,
  ]);
  function parse(text: string) {
    return enteredValue(filter.type, text, false);
  }
  const inputType = filter.type === "date" ? "date" : "text";
  const inputValue = (raw: unknown) => String(raw ?? "");
  if (filter.mode === "range")
    return (
      <div className="dashboard-filter-range">
        {(["from", "to"] as const).map((edge) => (
          <div className="field" key={edge}>
            <label htmlFor={`${id}-${edge}`}>{t(edge)}</label>
            <input
              id={`${id}-${edge}`}
              type={inputType}
              value={value?.kind === "range" ? inputValue(value[edge]) : ""}
              onChange={(event) => {
                try {
                  onChange({
                    kind: "range",
                    from: value?.kind === "range" ? value.from : null,
                    to: value?.kind === "range" ? value.to : null,
                    [edge]: event.target.value
                      ? parse(event.target.value)
                      : null,
                  });
                  setError(false);
                } catch {
                  setError(true);
                }
              }}
            />
          </div>
        ))}
        {error ? (
          <p className="error" role="alert">
            {t("invalidValue")}
          </p>
        ) : null}
      </div>
    );
  const selected = value?.kind === "values" ? value.values : [];
  return (
    <div className="dashboard-filter-values">
      {workspaceId && mapping ? (
        <div className="dashboard-filter-browser">
          <button
            type="button"
            aria-expanded={browse}
            aria-controls={`${id}-choices`}
            onClick={() => setBrowse((open) => !open)}
          >
            {t("browseValues")}
          </button>
          {browse ? (
            <div id={`${id}-choices`}>
              <label htmlFor={`${id}-search`}>{t("searchValues")}</label>
              <input
                id={`${id}-search`}
                type="search"
                value={search}
                maxLength={200}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setOffset(0);
                }}
              />
              {choicesLoading ? (
                <p role="status">{t("loadingValues")}</p>
              ) : null}
              {choicesError ? (
                <p className="error" role="status">
                  {t("choicesFailed")}{" "}
                  <button
                    type="button"
                    onClick={() => setRevision((value) => value + 1)}
                  >
                    {t("retry")}
                  </button>
                </p>
              ) : null}
              <ul className="dashboard-filter-options">
                {choices?.values.map((raw, index) => (
                  <li key={index}>
                    <button
                      type="button"
                      aria-pressed={selected.includes(raw)}
                      onClick={() =>
                        onChange({
                          kind: "values",
                          values: selected.includes(raw)
                            ? selected.filter((value) => value !== raw)
                            : [...selected, raw],
                        })
                      }
                    >
                      {raw === null
                        ? t("unmatched")
                        : typeof raw === "boolean"
                          ? t(raw ? "yes" : "no")
                          : String(raw)}
                    </button>
                  </li>
                ))}
              </ul>
              {choices?.total === 0 ? <p>{t("noValues")}</p> : null}
              {choices && choices.total > 100 ? (
                <div className="actions">
                  <button
                    type="button"
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - 100))}
                  >
                    {t("previousValues")}
                  </button>
                  <button
                    type="button"
                    disabled={offset + 100 >= choices.total}
                    onClick={() => setOffset(offset + 100)}
                  >
                    {t("nextValues")}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="dashboard-filter-chips">
        {selected.map((raw, index) => (
          <button
            type="button"
            key={index}
            onClick={() =>
              onChange({
                kind: "values",
                values: selected.filter((_, at) => at !== index),
              })
            }
            aria-label={t("removeValue", {
              value: raw === null ? t("unmatched") : String(raw),
            })}
          >
            {raw === null
              ? t("unmatched")
              : typeof raw === "boolean"
                ? t(raw ? "yes" : "no")
                : String(raw)}{" "}
            ×
          </button>
        ))}
      </div>
      <div className="dashboard-filter-entry">
        <label className="visually-hidden" htmlFor={id}>
          {filter.name}
        </label>
        {filter.type === "boolean" ? (
          <select
            id={id}
            value={text}
            onChange={(event) => setText(event.target.value)}
          >
            <option value="">{t("chooseValue")}</option>
            <option value="true">{t("yes")}</option>
            <option value="false">{t("no")}</option>
          </select>
        ) : (
          <input
            id={id}
            type={inputType}
            value={text}
            placeholder={t("enterValue")}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                const button =
                  event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(
                    "button",
                  );
                button?.click();
              }
            }}
          />
        )}
        <button
          type="button"
          disabled={text === ""}
          onClick={() => {
            try {
              const next = parse(text);
              onChange({
                kind: "values",
                values: [...selected.filter((value) => value !== next), next],
              });
              setText("");
              setError(false);
            } catch {
              setError(true);
            }
          }}
        >
          {t("addValue")}
        </button>
      </div>
      <div className="actions">
        <button type="button" onClick={() => onChange(null)}>
          {t("allValues")}
        </button>
        <button
          type="button"
          onClick={() =>
            onChange({
              kind: "values",
              values: [...selected.filter((raw) => raw !== null), null],
            })
          }
        >
          {t("unmatched")}
        </button>
      </div>
      {error ? (
        <p className="error" role="alert">
          {t("invalidValue")}
        </p>
      ) : null}
    </div>
  );
}
function CompactFilter({
  filter,
  value,
  workspaceId,
  onChange,
}: {
  filter: DashboardDataFilter;
  value: DashboardFilterValue;
  workspaceId?: string;
  onChange: (value: DashboardFilterValue) => void;
}) {
  const t = useT("data.dashboard"),
    id = useId(),
    [open, setOpen] = useState(false),
    [left, setLeft] = useState(0);
  const label =
    value === null
      ? t("allValues")
      : value.kind === "range"
        ? `${String(value.from ?? "…")} – ${String(value.to ?? "…")}`
        : value.values.length
          ? value.values
              .map((value) =>
                value === null
                  ? t("unmatched")
                  : typeof value === "boolean"
                    ? t(value ? "yes" : "no")
                    : String(value),
              )
              .join(", ")
          : t("allValues");
  return (
    <div
      className="dashboard-filter-control"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false);
          event.stopPropagation();
        }
      }}
      onBlur={(event) => {
        if (
          event.relatedTarget &&
          !event.currentTarget.contains(event.relatedTarget as Node)
        )
          setOpen(false);
      }}
    >
      <button
        type="button"
        className="dashboard-filter-trigger"
        aria-expanded={open}
        aria-controls={id}
        title={`${filter.name}: ${label}`}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setLeft(
            Math.min(
              0,
              window.innerWidth -
                rect.left -
                Math.min(340, window.innerWidth - 40) -
                20,
            ),
          );
          setOpen((open) => !open);
        }}
      >
        <span>{filter.name}</span>
        <strong>{label}</strong>
        <svg
          aria-hidden="true"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open ? (
        <div
          id={id}
          className="dashboard-filter-popover"
          style={{ left }}
          role="group"
          aria-label={filter.name}
        >
          <DashboardFilterInput
            initialBrowse
            workspaceId={workspaceId}
            filter={filter}
            value={value}
            onChange={onChange}
          />
          {filter.fixedValue ? (
            <p className="help">{t("fixedScopeActive")}</p>
          ) : null}
          <button
            type="button"
            className="primary"
            onClick={() => setOpen(false)}
          >
            {t("done")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
export function DashboardFilters({
  workspaceId,
  filters,
  values,
  onChange,
}: {
  workspaceId?: string;
  filters: DashboardDataFilter[];
  values: Record<string, DashboardFilterValue>;
  onChange: (value: Record<string, DashboardFilterValue>) => void;
}) {
  const t = useT("data.dashboard");
  return filters.length ? (
    <section
      className="dashboard-shared-filters"
      aria-label={t("sharedFilters")}
    >
      <div className="dashboard-filter-controls">
        {filters.map((filter) => (
          <CompactFilter
            key={filter.id}
            filter={filter}
            workspaceId={workspaceId}
            value={
              Object.hasOwn(values, filter.id)
                ? values[filter.id]!
                : filter.defaultValue
            }
            onChange={(value) => onChange({ ...values, [filter.id]: value })}
          />
        ))}
      </div>
      <button type="button" onClick={() => onChange({})}>
        {t("resetFilters")}
      </button>
    </section>
  ) : null;
}
