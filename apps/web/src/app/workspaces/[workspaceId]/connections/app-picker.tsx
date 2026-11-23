"use client";

import { useId, useRef, useState } from "react";
import type { DiscoveredResource } from "@netrics/contracts";
import { useFocusKeeper } from "@/lib/focus-handoff";
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
  // Changes here remove what may have the keyboard focus: a selected
  // resource the account no longer lists leaves the list when it is
  // unticked or the selection is cleared, a search or another page replaces
  // the rows, "all" removes the list with its search field and buttons.
  // The picker keeps its focus (`useFocusKeeper`): when the focused element
  // goes, the focus moves to the checkbox that took a row's place (or the
  // last one), else to the search field, else to the chosen mode. While
  // the whole picker is disabled it has nowhere to go here; the form around
  // it has its own keeper.
  const root = useRef<HTMLFieldSetElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const boxes = () => [
    ...(list.current?.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    ) ?? []),
  ];
  useFocusKeeper<number>(
    root,
    (row = -1) => {
      if (root.current?.disabled) return null;
      const rows = boxes();
      return (
        (row >= 0 ? rows[Math.min(row, rows.length - 1)] : undefined) ??
        searchField.current ??
        root.current?.querySelector<HTMLElement>(
          'input[type="radio"]:checked',
        ) ??
        root.current?.querySelector<HTMLElement>('input[type="radio"]')
      );
    },
    // The row of a focused checkbox, while it is still in the list.
    (element) => boxes().findIndex((box) => box === element),
  );
  function toggle(key: string) {
    if (selected.has(key)) selected.delete(key);
    else selected.add(key);
    onChange([...selected]);
  }
  function show(next: number) {
    if (next >= 0 && next < pages) setPage(next);
  }
  return (
    <fieldset className="stack app-picker" disabled={disabled} ref={root}>
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
                  onChange={() => toggle(resource.id)}
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
                // Not disabled at the first page: a disabled button drops
                // the keyboard focus that just pressed it.
                disabled={disabled}
                aria-disabled={current === 0}
                onClick={() => show(current - 1)}
              >
                {t("previous")}
              </button>
              {/* Read out when the page changes. */}
              <span role="status">
                {t("page", { page: current + 1, pages })}
              </span>
              <button
                type="button"
                disabled={disabled}
                aria-disabled={current + 1 === pages}
                onClick={() => show(current + 1)}
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
