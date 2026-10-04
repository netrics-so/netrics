"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { DashboardWidget, WorkspaceMetric } from "@netrics/contracts";
import { isDataWidgetType } from "@netrics/domain";

import { dataWidgetLabel } from "@/components/studio/metric-widget";
import {
  widgetName,
  type StudioAction,
  type StudioDocument,
} from "@/lib/studio-document";
import {
  unreadableCounts,
  unreadableLabels,
  type UnreadableLabel,
} from "@/lib/studio-readability";
import { metricKeyOf, type DataWidget } from "@/lib/studio-widgets";

// Canvas additions of #241: readability warnings, and copy, paste and
// duplicate for widgets (keyboard shortcuts and buttons).

/**
 * Data widgets whose label is cut off on TVs, by widget id, and their
 * count per slide. Labels are the renderers' ("Downloads · Wurfel").
 */
export function useUnreadableLabels(
  document: StudioDocument,
  metrics: ReadonlyMap<string, WorkspaceMetric>,
  fontScale: number,
): {
  byWidget: ReadonlyMap<string, UnreadableLabel>;
  perSlide: ReadonlyMap<string, number>;
} {
  return useMemo(() => {
    const labels = unreadableLabels(
      document,
      (widget) =>
        isDataWidgetType(widget.type)
          ? dataWidgetLabel(
              widget as DataWidget,
              metrics.get(metricKeyOf(widget as DataWidget)),
            )
          : "",
      fontScale,
    );
    return {
      byWidget: new Map(labels.map((label) => [label.widgetId, label])),
      perSlide: unreadableCounts(labels),
    };
  }, [document, metrics, fontScale]);
}

/** What a Cmd/Ctrl shortcut does to widgets, or null for other keys. */
export function clipboardKey(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
  >,
): "copy" | "paste" | "duplicate" | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) {
    return null;
  }
  switch (event.key.toLowerCase()) {
    case "c":
      return "copy";
    case "v":
      return "paste";
    case "d":
      return "duplicate";
    default:
      return null;
  }
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/**
 * The Studio's widget clipboard: Cmd/Ctrl+C copies the selected widget,
 * Cmd/Ctrl+V pastes it onto the selected slide (this one or another),
 * Cmd/Ctrl+D duplicates it. Text fields and selected page text keep the
 * browser's own copy and paste. The clipboard lives in the editor, not the
 * system clipboard: a widget is only meaningful inside this dashboard.
 */
export function useWidgetClipboard(
  selected: DashboardWidget | null,
  dispatch: (action: StudioAction) => void,
  enabled: boolean,
) {
  const [clipboard, setClipboard] = useState<DashboardWidget | null>(null);

  const copy = useCallback(() => {
    if (selected) {
      setClipboard(selected);
      dispatch({ type: "announce", text: `${widgetName(selected)} copied.` });
    }
  }, [selected, dispatch]);
  const paste = useCallback(() => {
    if (clipboard) {
      dispatch({ type: "pasteWidget", widget: clipboard });
    }
  }, [clipboard, dispatch]);
  const duplicate = useCallback(() => {
    if (selected) {
      dispatch({ type: "duplicateWidget", widgetId: selected.id });
    }
  }, [selected, dispatch]);

  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(event: KeyboardEvent) {
      const action = clipboardKey(event);
      if (!action || isTyping(event.target)) return;
      if (action !== "paste" && !selected) return;
      if (action === "copy" && window.getSelection()?.toString()) return;
      if (action === "paste" && !clipboard) return;
      event.preventDefault();
      ({ copy, paste, duplicate })[action]();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, selected, clipboard, copy, paste, duplicate]);

  return { clipboard, copy, paste, duplicate };
}

/** Buttons for the same, for pointer and touch users. */
export function WidgetClipboardBar({
  selected,
  clipboard,
  onCopy,
  onPaste,
  onDuplicate,
}: {
  selected: DashboardWidget | null;
  clipboard: DashboardWidget | null;
  onCopy: () => void;
  onPaste: () => void;
  onDuplicate: () => void;
}) {
  return (
    <div className="widget-clipboard" role="group" aria-label="Widget">
      <button
        type="button"
        disabled={!selected}
        onClick={onDuplicate}
        aria-keyshortcuts="Control+D Meta+D"
      >
        Duplicate
      </button>
      <button
        type="button"
        disabled={!selected}
        onClick={onCopy}
        aria-keyshortcuts="Control+C Meta+C"
      >
        Copy
      </button>
      <button
        type="button"
        disabled={!clipboard}
        onClick={onPaste}
        aria-keyshortcuts="Control+V Meta+V"
        title={clipboard ? `Paste ${widgetName(clipboard)}` : undefined}
      >
        Paste
      </button>
    </div>
  );
}
