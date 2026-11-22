"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { DiscoveredResource } from "@netrics/contracts";
import { holdsFocus } from "@/lib/focus-handoff";
import { useT } from "@/lib/i18n/client";

const PAGE_SIZE = 50;

/**
 * null follows all current and future apps; an empty list collects none.
 * `texts` names the resources: apps, or the projects of a website
 * connection (#782). `noneHelpId` is the id of the note shown for an empty
 * list, for a form that refers to it (#854).
 */
export function AppPicker({
  resources,
  value,
  onChange,
  disabled = false,
  texts = "connections.apps",
  noneHelpId,
}: {
  resources: DiscoveredResource[];
  value: string[] | null;
  onChange: (value: string[] | null) => void;
  disabled?: boolean;
  texts?: "connections.apps" | "connections.projects";
  noneHelpId?: string;
}) {
  const t = useT(texts);
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
  // A selected resource the account no longer lists leaves the list when
  // it is unticked, and its checkbox with it: if that checkbox has the
  // keyboard focus (`holdsFocus`), it goes to the checkbox that took its
  // place (or the last one, or the search field), instead of being dropped
  // to the page.
  const list = useRef<HTMLDivElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const refocus = useRef<number | null>(null);
  useEffect(() => {
    const index = refocus.current;
    if (index === null) return;
    refocus.current = null;
    const boxes = list.current?.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    (
      boxes?.[Math.min(index, (boxes?.length ?? 0) - 1)] ?? searchField.current
    )?.focus();
  });
  function toggle(key: string, box: HTMLInputElement) {
    if (selected.has(key)) {
      selected.delete(key);
      if (missing.includes(key) && holdsFocus(box))
        refocus.current = visible.findIndex((entry) => entry.id === key);
    } else selected.add(key);
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
              ref={searchField}
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
          <div className="app-picker-list" ref={list}>
            {visible.map((resource) => (
              <label className="checkbox-row" key={resource.id}>
                <input
                  type="checkbox"
                  checked={selected.has(resource.id)}
                  onChange={(event) => toggle(resource.id, event.currentTarget)}
                />
                <span>
                  {resource.name}
                  {resource.name !== resource.id ||
                  missing.includes(resource.id) ? (
                    <small className="help">
                      {resource.name !== resource.id ? resource.id : null}
                      {missing.includes(resource.id)
                        ? `${resource.name !== resource.id ? " · " : ""}${t("unlisted")}`
                        : ""}
                    </small>
                  ) : null}
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
            <p className="notice" id={noneHelpId}>
              {t("noneHelp")}
            </p>
          ) : null}
        </>
      ) : null}
      {missing.length ? <p className="help">{t("unlistedHelp")}</p> : null}
    </fieldset>
  );
}
