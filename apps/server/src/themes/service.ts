import {
  themeTokensSchema,
  type BuiltinThemeView,
  type CreateThemeRequest,
  type ThemeContrast,
  type UpdateThemeRequest,
  type WorkspaceTheme,
} from "@netrics/contracts";
import {
  deleteTheme,
  findTheme,
  insertAuditEvent,
  insertTheme,
  listThemes,
  updateTheme,
  withWorkspace,
  type Database,
  type ThemeUser,
  type Transaction,
  type WorkspaceThemeRow,
} from "@netrics/database";
import {
  BUILTIN_THEMES,
  BUILTIN_THEME_KEYS,
  checkThemeContrast,
  isBuiltinThemeKey,
  type BuiltinThemeKey,
  type ThemeTokens,
} from "@netrics/domain";

/**
 * Dashboard themes (#216, ADR 0015 section 6): the built-ins and the
 * workspace's custom themes. A custom theme is refused when a text pair is
 * below 3:1 and answered with warnings below 4.5:1.
 */

export interface Actor {
  workspaceId: string;
  callerId: string;
}

export type ThemeFailure =
  | { status: 400; error: "contrast_too_low"; contrast: ThemeContrast[] }
  | { status: 404; error: "theme_not_found" }
  | { status: 409; error: "theme_name_taken" | "version_conflict" }
  | { status: 409; error: "theme_in_use"; dashboards: ThemeUser[] };

export type ThemeResult<T> =
  { ok: true; value: T } | ({ ok: false } & ThemeFailure);

const NOT_FOUND = { ok: false, status: 404, error: "theme_not_found" } as const;

export function builtinThemes(): BuiltinThemeView[] {
  return BUILTIN_THEME_KEYS.map((key) => BUILTIN_THEMES[key]);
}

function tokensOf(row: WorkspaceThemeRow): ThemeTokens {
  return themeTokensSchema.parse(row.tokens) as ThemeTokens;
}

function present(row: WorkspaceThemeRow): WorkspaceTheme {
  const tokens = tokensOf(row);
  return {
    id: row.id,
    name: row.name,
    base: isBuiltinThemeKey(row.base) ? row.base : "netrics_dark",
    tokens,
    version: row.version,
    warnings: checkThemeContrast(tokens).filter(
      (check) => check.level !== "pass",
    ),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The pairs below 3:1, or null when the theme is readable enough. */
function failingContrast(tokens: ThemeTokens): ThemeContrast[] | null {
  const failing = checkThemeContrast(tokens).filter(
    (check) => check.level === "fail",
  );
  return failing.length > 0 ? failing : null;
}

/**
 * The tokens of a dashboard's theme reference, or null when the custom
 * theme is not in the workspace.
 */
export async function resolveThemeTokens(
  tx: Transaction,
  workspaceId: string,
  ref: { themeBuiltin: string | null; themeId: string | null },
): Promise<ThemeTokens | null> {
  if (ref.themeId !== null) {
    const row = await findTheme(tx, workspaceId, ref.themeId);
    return row ? tokensOf(row) : null;
  }
  const key: BuiltinThemeKey =
    ref.themeBuiltin !== null && isBuiltinThemeKey(ref.themeBuiltin)
      ? ref.themeBuiltin
      : "netrics_dark";
  return BUILTIN_THEMES[key].tokens;
}

export function createThemeService(deps: { db: Database }) {
  const inWorkspace = <T>(actor: Actor, run: (tx: Transaction) => Promise<T>) =>
    withWorkspace(
      deps.db,
      { workspaceId: actor.workspaceId, userId: actor.callerId },
      run,
    );

  return {
    list(actor: Actor) {
      return inWorkspace(actor, async (tx) => ({
        builtins: builtinThemes(),
        themes: (await listThemes(tx, actor.workspaceId)).map(present),
      }));
    },

    get(actor: Actor, themeId: string) {
      return inWorkspace(
        actor,
        async (tx): Promise<ThemeResult<WorkspaceTheme>> => {
          const row = await findTheme(tx, actor.workspaceId, themeId);
          return row ? { ok: true, value: present(row) } : NOT_FOUND;
        },
      );
    },

    create(actor: Actor, body: CreateThemeRequest) {
      return inWorkspace(
        actor,
        async (tx): Promise<ThemeResult<WorkspaceTheme>> => {
          const base = body.base as BuiltinThemeKey;
          const tokens = (body.tokens ??
            BUILTIN_THEMES[base].tokens) as ThemeTokens;
          const failing = failingContrast(tokens);
          if (failing) {
            return {
              ok: false,
              status: 400,
              error: "contrast_too_low",
              contrast: failing,
            };
          }
          const result = await insertTheme(tx, actor.workspaceId, {
            name: body.name,
            base,
            tokens,
          });
          if (result.status === "name_taken") {
            return { ok: false, status: 409, error: "theme_name_taken" };
          }
          await insertAuditEvent(tx, {
            workspaceId: actor.workspaceId,
            actorUserId: actor.callerId,
            action: "theme.created",
            target: result.theme.id,
            metadata: { name: result.theme.name, base },
          });
          return { ok: true, value: present(result.theme) };
        },
      );
    },

    update(actor: Actor, themeId: string, body: UpdateThemeRequest) {
      return inWorkspace(
        actor,
        async (tx): Promise<ThemeResult<WorkspaceTheme>> => {
          const tokens = body.tokens as ThemeTokens;
          const failing = failingContrast(tokens);
          if (failing) {
            return {
              ok: false,
              status: 400,
              error: "contrast_too_low",
              contrast: failing,
            };
          }
          const result = await updateTheme(
            tx,
            actor.workspaceId,
            themeId,
            body.version,
            { name: body.name, tokens },
          );
          switch (result.status) {
            case "not_found":
              return NOT_FOUND;
            case "name_taken":
              return { ok: false, status: 409, error: "theme_name_taken" };
            case "version_conflict":
              return { ok: false, status: 409, error: "version_conflict" };
          }
          await insertAuditEvent(tx, {
            workspaceId: actor.workspaceId,
            actorUserId: actor.callerId,
            action: "theme.updated",
            target: themeId,
            metadata: {
              name: result.theme.name,
              version: result.theme.version,
            },
          });
          return { ok: true, value: present(result.theme) };
        },
      );
    },

    remove(actor: Actor, themeId: string) {
      return inWorkspace(actor, async (tx): Promise<ThemeResult<null>> => {
        const result = await deleteTheme(tx, actor.workspaceId, themeId);
        if (result.status === "not_found") {
          return NOT_FOUND;
        }
        if (result.status === "in_use") {
          return {
            ok: false,
            status: 409,
            error: "theme_in_use",
            dashboards: result.dashboards,
          };
        }
        await insertAuditEvent(tx, {
          workspaceId: actor.workspaceId,
          actorUserId: actor.callerId,
          action: "theme.deleted",
          target: themeId,
          metadata: { name: result.theme.name },
        });
        return { ok: true, value: null };
      });
    },
  };
}
