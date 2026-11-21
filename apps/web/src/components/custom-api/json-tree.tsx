"use client";

import { useRef, useState, type KeyboardEvent } from "react";

import { formatDataPath, type DataPathSegment } from "@netrics/contracts";

import { useT } from "@/lib/i18n/client";

// The redacted, bounded test response as a collapsible tree (#807): click
// the list that holds the records, tick the fields to keep, or pick a
// value (the paging cursor). Paths are filled by clicking, never typed.

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type JsonTreeMode = "records" | "fields" | "value";

/** One visible row of the tree. */
export interface TreeItem {
  /** The node's path from the tree's root ("" = the root). */
  path: string;
  depth: number;
  /** Key or index shown before the value; null for the root. */
  label: string | null;
  kind: "object" | "array" | "leaf" | "marker";
  value: Json;
  /** Children count (objects: keys, arrays: items the server sent). */
  size: number;
  expanded: boolean;
  /** An array whose items are objects: it can be the records. */
  recordList: boolean;
  /** Collapsed array rows showing only the first item: the rest's count. */
  hiddenItems: number;
}

/** "… 12 more" (arrays), the key "…" (objects): markers the server cut. */
const ARRAY_MARKER = /^… \d+ more$/;
const isMarkerText = (value: Json) =>
  typeof value === "string" &&
  (ARRAY_MARKER.test(value) ||
    value === "… (nested deeper)" ||
    value === "… (response too large to show)");

const isObject = (value: Json): value is { [key: string]: Json } =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function isRecordList(value: Json): boolean {
  return (
    Array.isArray(value) &&
    value.some((item) => isObject(item)) &&
    value.every((item) => isObject(item) || isMarkerText(item))
  );
}

/** Levels below 2 start collapsed. */
export function initiallyExpanded(value: Json): Set<string> {
  const open = new Set<string>();
  const walk = (node: Json, segments: DataPathSegment[], depth: number) => {
    if (depth >= 2 || node === null || typeof node !== "object") return;
    open.add(formatDataPath(segments));
    if (Array.isArray(node)) {
      if (node.length) walk(node[0]!, [...segments, { index: 0 }], depth + 1);
    } else
      for (const [key, child] of Object.entries(node))
        if (key !== "…") walk(child, [...segments, { key }], depth + 1);
  };
  walk(value, [], 0);
  return open;
}

/** The rows the tree shows, in order, given which nodes are open. */
export function treeItems(
  value: Json,
  expanded: ReadonlySet<string>,
  showAll: ReadonlySet<string> = new Set(),
): TreeItem[] {
  const out: TreeItem[] = [];
  const visit = (
    node: Json,
    segments: DataPathSegment[],
    label: string | null,
    depth: number,
  ) => {
    const path = formatDataPath(segments);
    if (isMarkerText(node) || (label === "…" && typeof node === "string")) {
      out.push({
        path,
        depth,
        label: null,
        kind: "marker",
        value: label === "…" ? `… ${String(node)}` : node,
        size: 0,
        expanded: false,
        recordList: false,
        hiddenItems: 0,
      });
      return;
    }
    if (node === null || typeof node !== "object") {
      out.push({
        path,
        depth,
        label,
        kind: "leaf",
        value: node,
        size: 0,
        expanded: false,
        recordList: false,
        hiddenItems: 0,
      });
      return;
    }
    const open = expanded.has(path);
    const array = Array.isArray(node);
    const children: [string | number, Json][] = array
      ? node.map((child, index) => [index, child])
      : Object.entries(node).filter(([key]) => key !== "…");
    const marker = !array && Object.hasOwn(node, "…") ? node["…"] : undefined;
    const real = array ? children.filter(([, c]) => !isMarkerText(c)) : [];
    const shown =
      array && !showAll.has(path) && real.length > 1
        ? [children[0]!]
        : children;
    out.push({
      path,
      depth,
      label,
      kind: array ? "array" : "object",
      value: node,
      size: array ? real.length : children.length,
      expanded: open,
      recordList: isRecordList(node),
      hiddenItems: open ? children.length - shown.length : 0,
    });
    if (!open) return;
    for (const [key, child] of shown)
      visit(
        child,
        [...segments, typeof key === "number" ? { index: key } : { key }],
        typeof key === "number" ? `[${key}]` : key,
        depth + 1,
      );
    if (marker !== undefined)
      visit(marker, [...segments, { key: "…" }], "…", depth + 1);
  };
  visit(value, [], null, 0);
  return out;
}

export type TreeKeyAction =
  "next" | "prev" | "expand" | "collapse" | "toggle" | "pick" | null;

/** Keyboard: arrows move and open/close, Enter toggles, Space picks. */
export function treeKey(key: string, item: TreeItem): TreeKeyAction {
  const branch = item.kind === "object" || item.kind === "array";
  switch (key) {
    case "ArrowDown":
      return "next";
    case "ArrowUp":
      return "prev";
    case "ArrowRight":
      return branch && !item.expanded ? "expand" : "next";
    case "ArrowLeft":
      return branch && item.expanded ? "collapse" : "prev";
    case "Enter":
      return branch ? "toggle" : null;
    case " ":
      return "pick";
    default:
      return null;
  }
}

/** What Space (or the row's button) does on an item in a mode. */
export function pickOf(
  item: TreeItem,
  mode: JsonTreeMode,
): "records" | "field" | "value" | null {
  if (mode === "records") return item.recordList ? "records" : null;
  if (mode === "fields") return item.kind === "leaf" ? "field" : null;
  return item.kind === "leaf" && item.value !== null ? "value" : null;
}

function leafText(value: Json): string {
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

export interface JsonTreeProps {
  value: Json;
  /** The picked record list (records mode), highlighted. */
  recordPath: string | null;
  /** The suggested record list (records mode), highlighted until one is picked. */
  suggestedPath?: string | null;
  /** Ticked fields (fields mode), relative to the record. */
  fieldPaths: ReadonlySet<string>;
  /** Picked value (value mode). */
  valuePath?: string | null;
  mode: JsonTreeMode;
  onPickRecords?: (path: string) => void;
  onToggleField?: (path: string, on: boolean) => void;
  onPickValue?: (path: string) => void;
  label?: string;
}

export function JsonTree({
  value,
  recordPath,
  suggestedPath = null,
  fieldPaths,
  valuePath = null,
  mode,
  onPickRecords,
  onToggleField,
  onPickValue,
  label,
}: JsonTreeProps) {
  const t = useT("customApi");
  const [expanded, setExpanded] = useState(() => initiallyExpanded(value));
  const [showAll, setShowAll] = useState<Set<string>>(() => new Set());
  const [focused, setFocused] = useState("");
  const tree = useRef<HTMLUListElement>(null);
  const items = treeItems(value, expanded, showAll);

  const toggle = (path: string, open?: boolean) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (open ?? !next.has(path)) next.add(path);
      else next.delete(path);
      return next;
    });
  const pick = (item: TreeItem) => {
    const action = pickOf(item, mode);
    if (action === "records") onPickRecords?.(item.path);
    else if (action === "field")
      onToggleField?.(item.path, !fieldPaths.has(item.path));
    else if (action === "value") onPickValue?.(item.path);
  };
  const focus = (index: number) => {
    const target = items[Math.max(0, Math.min(items.length - 1, index))];
    if (!target) return;
    setFocused(target.path);
    tree.current
      ?.querySelector<HTMLElement>(`[data-path="${CSS.escape(target.path)}"]`)
      ?.focus();
  };
  const onKeyDown = (event: KeyboardEvent, item: TreeItem, index: number) => {
    const action = treeKey(event.key, item);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (action === "next") focus(index + 1);
    else if (action === "prev") focus(index - 1);
    else if (action === "expand") toggle(item.path, true);
    else if (action === "collapse") toggle(item.path, false);
    else if (action === "toggle") toggle(item.path);
    else pick(item);
  };
  const tabStop = items.some((item) => item.path === focused)
    ? focused
    : (items[0]?.path ?? "");

  return (
    <ul
      className="json-tree"
      role="tree"
      aria-label={label ?? t("tree.label")}
      ref={tree}
    >
      {items.map((item, index) => {
        const branch = item.kind === "object" || item.kind === "array";
        const action = pickOf(item, mode);
        const highlighted =
          (mode === "records" &&
            item.recordList &&
            (recordPath === null
              ? item.path === suggestedPath
              : item.path === recordPath)) ||
          (mode === "value" && item.path === valuePath);
        const ticked = mode === "fields" && fieldPaths.has(item.path);
        return (
          <li
            key={`${item.path}#${item.kind}`}
            role="treeitem"
            aria-level={item.depth + 1}
            aria-expanded={branch ? item.expanded : undefined}
            aria-selected={highlighted || ticked}
            tabIndex={item.path === tabStop ? 0 : -1}
            data-path={item.path}
            className={`json-tree-item json-tree-item--${item.kind}${highlighted ? " json-tree-item--picked" : ""}`}
            style={{ paddingInlineStart: `${item.depth * 16 + 4}px` }}
            onFocus={() => setFocused(item.path)}
            onKeyDown={(event) => onKeyDown(event, item, index)}
          >
            {branch ? (
              <button
                type="button"
                className="json-tree-toggle"
                tabIndex={-1}
                aria-label={
                  item.expanded ? t("tree.collapse") : t("tree.expand")
                }
                onClick={() => toggle(item.path)}
              >
                {item.expanded ? "▾" : "▸"}
              </button>
            ) : (
              <span className="json-tree-toggle" aria-hidden="true" />
            )}
            {mode === "fields" && action === "field" ? (
              <input
                type="checkbox"
                tabIndex={-1}
                checked={ticked}
                aria-label={item.path}
                onChange={(event) =>
                  onToggleField?.(item.path, event.target.checked)
                }
              />
            ) : null}
            {item.label !== null ? (
              <span className="json-tree-key">{item.label}</span>
            ) : null}
            {item.kind === "marker" ? (
              <span className="json-tree-marker">{String(item.value)}</span>
            ) : item.kind === "leaf" ? (
              <span
                className={`json-tree-value json-tree-value--${item.value === null ? "null" : typeof item.value}`}
              >
                {leafText(item.value)}
              </span>
            ) : (
              <span className="json-tree-summary">
                {item.kind === "array"
                  ? t("tree.items", { count: item.size })
                  : t("tree.keys", { count: item.size })}
              </span>
            )}
            {action === "records" ? (
              <button
                type="button"
                className={`json-tree-pick${highlighted ? " primary" : ""}`}
                tabIndex={-1}
                data-pick={item.path}
                onClick={() => pick(item)}
              >
                {t("response.useAsRecords")}
              </button>
            ) : null}
            {action === "value" ? (
              <button
                type="button"
                className="json-tree-pick"
                tabIndex={-1}
                data-pick={item.path}
                onClick={() => pick(item)}
              >
                {t("paging.useValue")}
              </button>
            ) : null}
            {item.hiddenItems > 0 ? (
              <button
                type="button"
                className="json-tree-more"
                tabIndex={-1}
                onClick={() =>
                  setShowAll((current) => new Set(current).add(item.path))
                }
              >
                {t("response.cut", { count: item.hiddenItems })}
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
