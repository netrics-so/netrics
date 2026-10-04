import {
  themeTokensSchema,
  type DashboardListResponse,
} from "@netrics/contracts";
import {
  listThemes,
  type DashboardSummary,
  type Transaction,
} from "@netrics/database";
import {
  BUILTIN_THEMES,
  DEFAULT_THEME_KEY,
  isBuiltinThemeKey,
  isScreenFormat,
  isHexColor,
  type BuiltinThemeKey,
  type ThemeTokens,
  type WidgetType,
} from "@netrics/domain";

type SummaryView = DashboardListResponse["dashboards"][number];

interface ResolvedTheme {
  builtin: BuiltinThemeKey | null;
  id: string | null;
  name: string;
  tokens: ThemeTokens;
}

/**
 * The dashboards page's cards (#304): each summary with its theme, accent,
 * and a thumbnail of its first enabled slide. Custom themes are read once,
 * from the caller's workspace only; a missing one falls back to netrics
 * Dark, as screens do.
 */
export async function presentSummaries(
  tx: Transaction,
  workspaceId: string,
  summaries: readonly DashboardSummary[],
): Promise<SummaryView[]> {
  const custom = new Map<string, { name: string; tokens: ThemeTokens }>();
  if (summaries.some((summary) => summary.themeId !== null)) {
    for (const row of await listThemes(tx, workspaceId)) {
      const parsed = themeTokensSchema.safeParse(row.tokens);
      if (parsed.success) {
        custom.set(row.id, {
          name: row.name,
          tokens: parsed.data as ThemeTokens,
        });
      }
    }
  }
  return summaries.map((summary) => {
    const theme = resolveTheme(summary, custom);
    const accent =
      summary.accentColor !== null &&
      isHexColor(summary.accentColor.toLowerCase())
        ? summary.accentColor.toLowerCase()
        : theme.tokens.accent;
    return {
      id: summary.id,
      name: summary.name,
      projectId: summary.projectId,
      version: summary.version,
      tileCount: summary.tileCount,
      slideCount: summary.slideCount,
      widgetCount: summary.widgetCount,
      updatedAt: summary.updatedAt.toISOString(),
      theme: { builtin: theme.builtin, id: theme.id, name: theme.name },
      accent,
      primaryFormat: isScreenFormat(summary.primaryFormat)
        ? summary.primaryFormat
        : "16x9",
      screenCount: summary.screenCount,
      preview: {
        background: theme.tokens.background,
        surface: theme.tokens.surface,
        border: theme.tokens.border,
        widgets: summary.previewWidgets.map((widget) => ({
          ...widget,
          type: widget.type as WidgetType,
        })),
      },
    };
  });
}

function resolveTheme(
  summary: Pick<DashboardSummary, "themeBuiltin" | "themeId">,
  custom: ReadonlyMap<string, { name: string; tokens: ThemeTokens }>,
): ResolvedTheme {
  const own = summary.themeId ? custom.get(summary.themeId) : undefined;
  if (summary.themeId && own) {
    return { builtin: null, id: summary.themeId, ...own };
  }
  const key: BuiltinThemeKey =
    summary.themeBuiltin && isBuiltinThemeKey(summary.themeBuiltin)
      ? summary.themeBuiltin
      : DEFAULT_THEME_KEY;
  const { name, tokens } = BUILTIN_THEMES[key];
  return { builtin: key, id: null, name, tokens };
}
