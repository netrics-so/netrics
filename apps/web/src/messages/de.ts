import type { Catalog } from "@netrics/domain";

import { accountDe } from "./account/de";
import { apiErrorsDe } from "./api-errors/de";
import { authDe } from "./auth/de";
import { commonDe } from "./common/de";
import { dashboardsDe } from "./dashboards/de";
import type { WebMessages } from "./en";
import { formatsDe } from "./formats/de";
import { screenDe } from "./screen/de";
import { screensDe } from "./screens/de";
import { settingsDe } from "./settings/de";
import { shellDe } from "./shell/de";
import { studioDe } from "./studio/de";
import { workspaceDe } from "./workspace/de";

/**
 * German (ADR 0016): informal "du", sentence case.
 *
 * Glossary (extend with each area): Workspace, Dashboard, Widget, Studio,
 * Connector stay; connection → Verbindung; slide → Folie; theme → Design;
 * screen → Bildschirm; sign in → anmelden; settings → Einstellungen; owner,
 * admin, editor, viewer → Inhaber, Admin, Bearbeiter, Betrachter. Product
 * names (netrics, App Store Connect, Search Console, Vercel) stay as they
 * are.
 */
export const de: Catalog<WebMessages> = {
  ...commonDe,
  ...accountDe,
  ...apiErrorsDe,
  ...formatsDe,
  ...authDe,
  ...workspaceDe,
  ...dashboardsDe,
  ...studioDe,
  ...settingsDe,
  ...screenDe,
  ...screensDe,
  ...shellDe,
};
