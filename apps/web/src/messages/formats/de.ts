import type { Catalog } from "@netrics/domain";

import type { formatsEn } from "./en";

export const formatsDe: Catalog<typeof formatsEn> = {
  formats: {
    time: {
      justNow: "gerade eben",
      never: "nie",
    },
    interval: {
      day: "{count, plural, one {jeden Tag} other {alle # Tage}}",
      hour: "{count, plural, one {jede Stunde} other {alle # Stunden}}",
      minute: "{count, plural, one {jede Minute} other {alle # Minuten}}",
      second: "{count, plural, one {jede Sekunde} other {alle # Sekunden}}",
    },
    nextSync: {
      pausedReconnect: "Pausiert, bis die Verbindung erneuert ist",
      pausedCredentials: "Pausiert, bis die Zugangsdaten funktionieren",
    },
    metric: {
      perBreakdown: "{name} (pro {dimensions})",
      notConverted: "{amount} nicht umgerechnet",
    },
  },
};
