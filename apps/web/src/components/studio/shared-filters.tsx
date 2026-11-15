"use client";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  formatDataDate,
  type DashboardDataFilter,
  type DashboardFilterValue,
} from "@netrics/domain";
import { loadDimensionValues } from "@/lib/dashboard-data-api";
import { enteredValue } from "@/lib/data-editing";
import { useLocale, useT } from "@/lib/i18n/client";

/** A filter value as shown: days and timestamps in the locale's format. */
export function filterValueText(
  filter: Pick<DashboardDataFilter, "type">,
  value: unknown,
  locale: string,
): string {
  return formatDataDate(value, filter.type, locale) ?? String(value);
}
export function DashboardFilterInput({
  filter,
  workspaceId,
  initialBrowse = false,
  value,
  onChange,
  onLabels,
}: {
  filter: DashboardDataFilter;
  workspaceId?: string;
  initialBrowse?: boolean;
  value: DashboardFilterValue;
  onChange: (value: DashboardFilterValue) => void;
  onLabels?: (labels: Record<string, string>) => void;
}) {
  const id = useId(),
    t = useT("data.dashboard"),
    locale = useLocale(),
    [text, setText] = useState(""),
    [error, setError] = useState(false);
  const [browse, setBrowse] = useState(initialBrowse),
    [search, setSearch] = useState(""),
    [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0);
  const [choices, setChoices] = useState<{
      values: unknown[];
      labels?: string[];
      total: number;
    } | null>(null),
    [choicesError, setChoicesError] = useState(false),
    [choicesLoading, setChoicesLoading] = useState(false);
  const [labelCache, setLabelCache] = useState<Record<string, string>>({});
  const searchRef = useRef<HTMLInputElement>(null),
    focusSearch = useRef(false);
  const mapping = filter.mappings[0];
  // "Browse values" only expands the list (#624); focus then moves to its
  // search field, since the button that had it is gone.
  useEffect(() => {
    if (browse && focusSearch.current) {
      focusSearch.current = false;
      searchRef.current?.focus();
    }
  }, [browse]);
  useEffect(() => {
    setLabelCache({});
  }, [mapping?.modelId, mapping?.dimensionId]);
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
          if (alive) {
            setChoices(response);
            if (response.labels)
              onLabels?.(
                Object.fromEntries(
                  response.values.map((value, index) => [
                    JSON.stringify(value),
                    response.labels![index]!,
                  ]),
                ),
              );
            if (response.labels)
              setLabelCache((current) => ({
                ...current,
                ...Object.fromEntries(
                  response.values.map((value, index) => [
                    JSON.stringify(value),
                    response.labels![index]!,
                  ]),
                ),
              }));
          }
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
    onLabels,
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
          {browse ? null : (
            <button
              type="button"
              aria-expanded={false}
              aria-controls={`${id}-choices`}
              onClick={() => {
                focusSearch.current = true;
                setBrowse(true);
              }}
            >
              {t("browseValues")}
            </button>
          )}
          {browse ? (
            <div id={`${id}-choices`}>
              <label htmlFor={`${id}-search`}>{t("searchValues")}</label>
              <input
                ref={searchRef}
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
                      {choices.labels?.[index] ||
                        (raw === null
                          ? t("unmatched")
                          : typeof raw === "boolean"
                            ? t(raw ? "yes" : "no")
                            : filterValueText(filter, raw, locale))}
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
              value:
                raw === null
                  ? t("unmatched")
                  : filterValueText(filter, raw, locale),
            })}
          >
            {labelCache[JSON.stringify(raw)] ||
              (raw === null
                ? t("unmatched")
                : typeof raw === "boolean"
                  ? t(raw ? "yes" : "no")
                  : filterValueText(filter, raw, locale))}{" "}
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
  open,
  onOpenChange,
  sheet,
  onChange,
}: {
  filter: DashboardDataFilter;
  value: DashboardFilterValue;
  workspaceId?: string;
  /** One popover at a time (#624): the filter bar owns which is open. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Where the popover opens as a full-width sheet in the page flow, below
   * the filter bar, when the bar wraps or is narrow: anchored under its
   * trigger it would cover the triggers of the next row (#624).
   */
  sheet: HTMLElement | null;
  onChange: (value: DashboardFilterValue) => void;
}) {
  const t = useT("data.dashboard"),
    locale = useLocale(),
    id = useId(),
    [left, setLeft] = useState(0);
  const controlRef = useRef<HTMLDivElement>(null),
    triggerRef = useRef<HTMLButtonElement>(null),
    popoverRef = useRef<HTMLDivElement>(null);
  const close = useCallback(
    (restoreFocus: boolean) => {
      onOpenChange(false);
      if (restoreFocus) triggerRef.current?.focus();
    },
    [onOpenChange],
  );
  // A press anywhere outside the control closes the popover, also where
  // pressing does not move focus (Safari buttons, plain page areas).
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !controlRef.current?.contains(target) &&
        !popoverRef.current?.contains(target)
      )
        close(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open, close]);
  // Opening moves focus into the popover: to its first control, or, on
  // touch screens, to the popover itself, so that no on-screen keyboard
  // covers the values.
  useEffect(() => {
    const popover = popoverRef.current;
    if (!open || !popover) return;
    if (window.matchMedia?.("(pointer: coarse)").matches) popover.focus();
    else
      popover
        .querySelector<HTMLElement>(
          "input:not([disabled]), select:not([disabled]), button:not([disabled])",
        )
        ?.focus();
  }, [open, sheet]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const receiveLabels = useCallback(
    (next: Record<string, string>) =>
      setLabels((current) => ({ ...current, ...next })),
    [],
  );
  const mapping = filter.mappings[0];
  const selectedKey = JSON.stringify(
    value?.kind === "values" ? value.values : [],
  );
  useEffect(() => {
    if (!workspaceId || !mapping) return;
    let alive = true;
    const selected = JSON.parse(selectedKey) as unknown[];
    const load = async () => {
      for (let offset = 0; offset < selected.length && alive; offset += 4) {
        const results = await Promise.allSettled(
          selected.slice(offset, offset + 4).map(async (value) => {
            if (value === null) return {};
            const response = await loadDimensionValues(
              workspaceId,
              mapping.modelId,
              mapping.dimensionId,
              String(value),
            );
            const index = response.values.findIndex(
              (candidate) =>
                JSON.stringify(candidate) === JSON.stringify(value),
            );
            return index >= 0 && response.labels?.[index]
              ? { [JSON.stringify(value)]: response.labels[index]! }
              : {};
          }),
        );
        if (alive)
          for (const result of results)
            if (result.status === "fulfilled") receiveLabels(result.value);
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [
    workspaceId,
    mapping?.modelId,
    mapping?.dimensionId,
    selectedKey,
    receiveLabels,
  ]);
  const label =
    value === null
      ? t("allValues")
      : value.kind === "range"
        ? `${value.from == null ? "…" : filterValueText(filter, value.from, locale)} – ${value.to == null ? "…" : filterValueText(filter, value.to, locale)}`
        : value.values.length
          ? value.values
              .map(
                (value) =>
                  labels[JSON.stringify(value)] ||
                  (value === null
                    ? t("unmatched")
                    : typeof value === "boolean"
                      ? t(value ? "yes" : "no")
                      : filterValueText(filter, value, locale)),
              )
              .join(", ")
          : t("allValues");
  return (
    <div
      ref={controlRef}
      className="dashboard-filter-control"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          close(true);
          event.stopPropagation();
        }
      }}
      onBlur={(event) => {
        if (
          open &&
          event.relatedTarget &&
          !event.currentTarget.contains(event.relatedTarget as Node) &&
          !popoverRef.current?.contains(event.relatedTarget as Node)
        )
          close(false);
      }}
    >
      <button
        ref={triggerRef}
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
          onOpenChange(!open);
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
        <Sheet target={sheet}>
          <div
            ref={popoverRef}
            id={id}
            className={
              sheet
                ? "dashboard-filter-popover dashboard-filter-sheet"
                : "dashboard-filter-popover"
            }
            style={sheet ? undefined : { left }}
            role="group"
            aria-label={filter.name}
            tabIndex={-1}
          >
            <DashboardFilterInput
              initialBrowse
              workspaceId={workspaceId}
              filter={filter}
              value={value}
              onChange={onChange}
              onLabels={receiveLabels}
            />
            {filter.fixedValue ? (
              <p className="help">{t("fixedScopeActive")}</p>
            ) : null}
            <button
              type="button"
              className="primary"
              onClick={() => close(true)}
            >
              {t("done")}
            </button>
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}
/** Children in `target` (a portal) when given, else in place. */
function Sheet({
  target,
  children,
}: {
  target: HTMLElement | null;
  children: ReactNode;
}) {
  return target ? createPortal(children, target) : <>{children}</>;
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
  const t = useT("data.dashboard"),
    // The open popover, by the same key as its control: a filter whose
    // mapping changes mounts anew, closed.
    [openKey, setOpenKey] = useState<string | null>(null);
  const barRef = useRef<HTMLElement>(null),
    [sheet, setSheet] = useState<HTMLDivElement | null>(null),
    [stacked, setStacked] = useState(false);
  // Popovers anchor under their trigger only while the triggers and the
  // reset button share one row; otherwise they open as a sheet below the
  // bar, pushing the dashboard down, and never cover another trigger.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const measure = () => {
      const boxes = Array.from(
        bar.querySelectorAll<HTMLElement>(
          ".dashboard-filter-trigger, .dashboard-filter-reset",
        ),
        (element) => element.getBoundingClientRect(),
      );
      // Wrapped: some control starts below where another one ends.
      const lowestTop = Math.max(...boxes.map((box) => box.top)),
        highestBottom = Math.min(...boxes.map((box) => box.bottom));
      setStacked(
        bar.clientWidth < 480 ||
          (boxes.length > 1 && lowestTop >= highestBottom - 1),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [filters.length]);
  return filters.length ? (
    <section
      ref={barRef}
      className="dashboard-shared-filters"
      aria-label={t("sharedFilters")}
    >
      <div className="dashboard-filter-controls">
        {filters.map((filter) => {
          const key = filter.id + JSON.stringify(filter.mappings[0]);
          return (
            <CompactFilter
              key={key}
              filter={filter}
              workspaceId={workspaceId}
              open={openKey === key}
              sheet={stacked ? sheet : null}
              onOpenChange={(open) =>
                setOpenKey((current) =>
                  open ? key : current === key ? null : current,
                )
              }
              value={
                Object.hasOwn(values, filter.id)
                  ? values[filter.id]!
                  : filter.defaultValue
              }
              onChange={(value) => onChange({ ...values, [filter.id]: value })}
            />
          );
        })}
      </div>
      <button
        type="button"
        className="dashboard-filter-reset"
        onClick={() => onChange({})}
      >
        {t("resetFilters")}
      </button>
      <div ref={setSheet} className="dashboard-filter-sheet-slot" />
    </section>
  ) : null;
}
