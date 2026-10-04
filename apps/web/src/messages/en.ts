import { accountEn } from "./account/en";
import { apiErrorsEn } from "./api-errors/en";
import { authEn } from "./auth/en";
import { commonEn } from "./common/en";
import { dashboardsEn } from "./dashboards/en";
import { formatsEn } from "./formats/en";
import { goalsEn } from "./goals/en";
import { screenEn } from "./screen/en";
import { screensEn } from "./screens/en";
import { settingsEn } from "./settings/en";
import { shellEn } from "./shell/en";
import { sourcesEn } from "./sources/en";
import { studioEn } from "./studio/en";
import { workspaceEn } from "./workspace/en";

/**
 * The web app's English messages: the source catalog (ADR 0016). Every
 * other language is typed against this one. ICU MessageFormat subset:
 * `{arg}`, `{n, plural, …}`, `{x, select, …}`; see @netrics/domain i18n.
 *
 * Each area keeps its strings in its own module (messages/<area>/en.ts and
 * de.ts) with its own top-level groups, so areas are translated and
 * reviewed independently; the groups of two areas never overlap (checked
 * in lib/i18n/i18n.test.ts).
 */
export const EN_AREAS = {
  common: commonEn,
  account: accountEn,
  apiErrors: apiErrorsEn,
  formats: formatsEn,
  auth: authEn,
  workspace: workspaceEn,
  dashboards: dashboardsEn,
  goals: goalsEn,
  studio: studioEn,
  settings: settingsEn,
  screen: screenEn,
  screens: screensEn,
  shell: shellEn,
  sources: sourcesEn,
} as const;

export const en = {
  ...commonEn,
  ...accountEn,
  ...apiErrorsEn,
  ...formatsEn,
  ...authEn,
  ...workspaceEn,
  ...dashboardsEn,
  ...goalsEn,
  ...studioEn,
  ...settingsEn,
  ...screenEn,
  ...screensEn,
  ...shellEn,
  ...sourcesEn,
} as const;

export type WebMessages = typeof en;
