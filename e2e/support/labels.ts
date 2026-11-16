import { dataDe } from "../../apps/web/src/messages/data/de.ts";
import { dataEn } from "../../apps/web/src/messages/data/en.ts";
import { dashboardsDe } from "../../apps/web/src/messages/dashboards/de.ts";
import { dashboardsEn } from "../../apps/web/src/messages/dashboards/en.ts";
import { settingsDe } from "../../apps/web/src/messages/settings/de.ts";
import { settingsEn } from "../../apps/web/src/messages/settings/en.ts";
import { shellDe } from "../../apps/web/src/messages/shell/de.ts";
import { shellEn } from "../../apps/web/src/messages/shell/en.ts";
import { workspaceDe } from "../../apps/web/src/messages/workspace/de.ts";
import { workspaceEn } from "../../apps/web/src/messages/workspace/en.ts";

export type Locale = "en" | "de";

/** The data area's UI text in `locale`, from the web app's own catalogs. */
export function labels(locale: Locale): (typeof dataEn)["data"] {
  return (locale === "de" ? dataDe : dataEn).data as (typeof dataEn)["data"];
}

/** A catalog message with its `{name}` placeholders filled in. */
export function fill(
  message: string,
  values: Record<string, string | number>,
): string {
  return message.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

/** The project UI's text in `locale` (#640): settings, sidebar, dashboards. */
export function projectLabels(locale: Locale) {
  const de = locale === "de";
  return {
    settings: (de ? settingsDe : settingsEn)
      .workspaceSettings as (typeof settingsEn)["workspaceSettings"],
    page: (de ? settingsDe : settingsEn)
      .projectsPage as (typeof settingsEn)["projectsPage"],
    shell: (de ? shellDe : shellEn).shell as (typeof shellEn)["shell"],
    dashboards: (de ? dashboardsDe : dashboardsEn)
      .dashboardsPage as (typeof dashboardsEn)["dashboardsPage"],
    workspace: (de ? workspaceDe : workspaceEn)
      .workspace as (typeof workspaceEn)["workspace"],
  };
}
