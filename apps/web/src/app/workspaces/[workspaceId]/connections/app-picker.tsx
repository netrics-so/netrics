"use client";

import { useId, useState } from "react";
import type { DiscoveredResource } from "@netrics/contracts";
import { useT } from "@/lib/i18n/client";

const PAGE_SIZE = 50;

/** null follows all current and future apps; an empty list collects none. */
export function AppPicker({
  resources,
  value,
  onChange,
  disabled = false,
}: {
  resources: DiscoveredResource[];
  value: string[] | null;
  onChange: (value: string[] | null) => void;
  disabled?: boolean;
}) {
  const t = useT("connections.apps");
  const id = useId();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const selected = new Set(value ?? []);
  const listed = new Set(resources.map((resource) => resource.id));
  const missing = (value ?? []).filter((key) => !listed.has(key));
  const choices = [
    ...resources,
    ...missing.map((key) => ({ id: key, name: key, kind: "unlisted" })),
  ];
  const needle = search.trim().toLocaleLowerCase();
  const filtered = choices.filter((resource) =>
    `${resource.name} ${resource.id}`.toLocaleLowerCase().includes(needle),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const visible = filtered.slice(
    current * PAGE_SIZE,
    (current + 1) * PAGE_SIZE,
  );
  function toggle(key: string) {
    if (selected.has(key)) selected.delete(key);
    else selected.add(key);
    onChange([...selected]);
  }
  return (
    <fieldset className="stack app-picker" disabled={disabled}>
      <legend>{t("title")}</legend>
      <label className="checkbox-row">
        <input
          type="radio"
          name={id}
          checked={value === null}
          onChange={() => onChange(null)}
        />
        <span>
          {t("all")}
          <small className="help">{t("allHelp")}</small>
        </span>
      </label>
      <label className="checkbox-row">
        <input
          type="radio"
          name={id}
          checked={value !== null}
          onChange={() => onChange(resources.map((resource) => resource.id))}
        />
        {t("choose")}
      </label>
      {value !== null ? (
        <>
          <div className="field">
            <label htmlFor={`${id}-search`}>{t("search")}</label>
            <input
              id={`${id}-search`}
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(0);
              }}
            />
          </div>
          <div className="actions">
            <button
              type="button"
              onClick={() =>
                onChange([
                  ...new Set([
                    ...value,
                    ...filtered.map((resource) => resource.id),
                  ]),
                ])
              }
            >
              {t("selectResults", { count: filtered.length })}
            </button>
            <button type="button" onClick={() => onChange([])}>
              {t("clear")}
            </button>
          </div>
          <p className="muted" role="status">
            {t("selected", { count: value.length })}
          </p>
          <div className="app-picker-list">
            {visible.map((resource) => (
              <label className="checkbox-row" key={resource.id}>
                <input
                  type="checkbox"
                  checked={selected.has(resource.id)}
                  onChange={() => toggle(resource.id)}
                />
                <span>
                  {resource.name}
                  <small className="help">
                    {resource.id}
                    {missing.includes(resource.id) ? ` · ${t("unlisted")}` : ""}
                  </small>
                </span>
              </label>
            ))}
          </div>
          {filtered.length === 0 ? (
            <p className="muted">
              {resources.length === 0 ? t("empty") : t("noResults")}
            </p>
          ) : null}
          {pages > 1 ? (
            <nav className="actions" aria-label={t("pages")}>
              <button
                type="button"
                disabled={disabled || current === 0}
                onClick={() => setPage(current - 1)}
              >
                {t("previous")}
              </button>
              <span>{t("page", { page: current + 1, pages })}</span>
              <button
                type="button"
                disabled={disabled || current + 1 === pages}
                onClick={() => setPage(current + 1)}
              >
                {t("next")}
              </button>
            </nav>
          ) : null}
          {value.length === 0 ? (
            <p className="notice">{t("noneHelp")}</p>
          ) : null}
        </>
      ) : null}
      {missing.length ? <p className="help">{t("unlistedHelp")}</p> : null}
    </fieldset>
  );
}
