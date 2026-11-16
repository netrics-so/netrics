"use client";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { DashboardWidget, DashboardWidgetData } from "@netrics/contracts";
import type {
  DashboardDataFilter,
  DashboardFilterValue,
} from "@netrics/domain";
import { previewDashboardMeasures } from "@/lib/dashboard-data-api";
const Context = createContext<{
  widgets: ReadonlyMap<string, DashboardWidgetData>;
  loading: boolean;
} | null>(null);
export const useDashboardData = () => useContext(Context);
export function DashboardDataProvider({
  workspaceId,
  widgets,
  filters = [],
  values = {},
  onLoaded,
  children,
}: {
  workspaceId: string;
  widgets: readonly DashboardWidget[];
  filters?: DashboardDataFilter[];
  values?: Record<string, DashboardFilterValue>;
  /**
   * Called with the time of each successful load: a wall screen's offline
   * note says when its data last updated (#681).
   */
  onLoaded?: (at: number) => void;
  children: ReactNode;
}) {
  const loaded = useRef(onLoaded);
  useEffect(() => {
    loaded.current = onLoaded;
  });
  const key = JSON.stringify({
    widgets: widgets
      .filter((widget) => widget.type === "measure")
      .map(({ id, binding, options }) => ({ id, binding, options })),
    filters,
    values,
  });
  const [state, setState] = useState<{
    key: string;
    widgets: Map<string, DashboardWidgetData>;
    loading: boolean;
  }>({ key, widgets: new Map(), loading: true });
  useEffect(() => {
    let alive = true;
    const input = JSON.parse(key) as {
      widgets: Extract<DashboardWidget, { type: "measure" }>[];
      filters: DashboardDataFilter[];
      values: Record<string, DashboardFilterValue>;
    };
    async function refresh() {
      if (!input.widgets.length) {
        if (alive) setState({ key, widgets: new Map(), loading: false });
        return;
      }
      if (alive)
        setState((state) => ({
          key,
          widgets: state.key === key ? state.widgets : new Map(),
          loading: true,
        }));
      try {
        const response = await previewDashboardMeasures(
          workspaceId,
          input.filters,
          input.values,
          input.widgets,
        );
        if (alive) {
          setState({
            key,
            widgets: new Map(
              response.widgets.map((widget) => [widget.widgetId, widget]),
            ),
            loading: false,
          });
          loaded.current?.(Date.now());
        }
      } catch {
        if (alive)
          setState({
            key,
            widgets: new Map(
              input.widgets.map((widget) => [
                widget.id,
                {
                  widgetId: widget.id,
                  metadata: null,
                  result: null,
                  error: "data_storage_failed",
                  exclusions: widget.binding.exclusions,
                },
              ]),
            ),
            loading: false,
          });
      }
    }
    const first = setTimeout(() => void refresh(), 100),
      interval = setInterval(() => void refresh(), 60000);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [workspaceId, key]);
  return (
    <Context
      value={state.key === key ? state : { widgets: new Map(), loading: true }}
    >
      {children}
    </Context>
  );
}
