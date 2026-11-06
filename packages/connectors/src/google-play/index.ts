import { createHash } from "node:crypto";

import type {
  CheckResult,
  ConnectionContext,
  Connector,
  ConnectorManifest,
  ConnectorRuntime,
  ManifestTranslation,
  Resource,
  ResourceIconsResult,
} from "@netrics/connector-sdk";
import { RESOURCE_ICON_MAX_BYTES } from "@netrics/connector-sdk";
import { z } from "zod";

import {
  accessibleApps,
  bucketName,
  createPlayReportsClient,
  manualPackages,
  PlayReportError,
  REPORTING_HOST,
  REPORTING_SCOPE,
  STORAGE_HOST,
  STORAGE_SCOPE,
  validPackage,
} from "./api.js";
import {
  earningsDataset,
  installDataset,
  listingRatingDataset,
  reportStatusDataset,
} from "./datasets.js";
import {
  listingScope,
  listingSnapshot,
  PLAY_ARTWORK_HOST,
  PLAY_STORE_HOST,
  type ListingSnapshot,
} from "./ratings.js";
import { reportCatalog, reportedPackages, syncPlayReports } from "./sync.js";

const de: ManifestTranslation = {
  name: "Google Play",
  description:
    "Installationsberichte, genaue Erlöszeilen einschließlich Gebühren und Rückerstattungen sowie öffentliche Bewertungen deiner Apps für das gewählte Land. Ein Google-Konto verbindet mehrere Apps.",
  resourceNoun: { singular: "App", plural: "Apps" },
  config: {
    reportBucket: {
      title: "Berichts-URI",
      description:
        "Kopiere in der Play Console unter Kontoverwaltung → Play-App-Berichte die Google-Cloud-Storage-URI, die mit gs://pubsite_prod_rev_ beginnt. Du brauchst Zugriff auf die Statistik- und Finanzberichte.",
    },
    ratingStorefront: {
      title: "Land für Bewertungen",
      description:
        "Ländercode aus zwei Buchstaben, zum Beispiel DE oder US. Standard: US. Die öffentliche Bewertung und ihre Anzahl gelten für dieses Land und den Standard-Gerätetyp der Store-Seite.",
    },
    ratingLanguage: {
      title: "Sprache der Store-Seite",
      description:
        "Sprachcode für den öffentlichen Eintrag, zum Beispiel de, en oder pt-BR. Standard: en.",
    },
    historyFrom: {
      title: "Frühestes Berichtsdatum",
      description:
        "Optionales Datum als JJJJ-MM-TT für einen längeren oder kürzeren ersten Import. Ohne Angabe wird ein Jahr importiert. Es können nur vorhandene Berichte gelesen werden.",
    },
    packageNames: {
      title: "Weitere Paketnamen",
      description:
        "Optionale Android-Paketnamen, getrennt durch Kommas, zum Beispiel com.example.app. Für Apps, die noch keine Berichte haben oder nicht automatisch gefunden werden.",
    },
  },
};
export const googlePlayManifest: ConnectorManifest = {
  id: "google-play",
  version: "0.1.0",
  sdkVersion: "^0.2.9",
  category: "apps",
  brandColor: "#34a853",
  name: "Google Play",
  description:
    "Install reports, exact earnings lines including fees and refunds, and scoped public listing ratings for your apps. Connect several apps with one Google account.",
  url: "https://play.google.com/console/",
  docsUrl:
    "https://github.com/netrics-so/netrics/blob/main/docs/connectors/google-play.md",
  authStrategies: [
    {
      strategy: "oauth2",
      provider: "google",
      scopes: [STORAGE_SCOPE, REPORTING_SCOPE],
    },
  ],
  configSchema: {
    type: "object",
    properties: {
      reportBucket: {
        type: "string",
        title: "Report URI",
        description:
          "In Play Console, open Manage account → Play apps reports and copy the Google Cloud Storage URI beginning with gs://pubsite_prod_rev_. Your account needs access to statistics and financial reports.",
      },
      ratingStorefront: {
        type: "string",
        title: "Rating country",
        description:
          "Two-letter country code, for example US or DE. Defaults to US. Public rating and count refer to this country's listing and its default form factor.",
        default: "US",
      },
      ratingLanguage: {
        type: "string",
        title: "Listing language",
        description:
          "Language code for the public listing, for example en, de or pt-BR. Defaults to en.",
        default: "en",
      },
      historyFrom: {
        type: "string",
        title: "Earliest report date",
        description:
          "Optional YYYY-MM-DD date for a longer or shorter first import. Defaults to one year. Only reports available from the provider can be read.",
      },
      packageNames: {
        type: "string",
        title: "Additional package names",
        description:
          "Optional comma-separated Android package names such as com.example.app, for apps without reports yet or apps that are not discovered automatically.",
      },
    },
    required: ["reportBucket"],
    additionalProperties: false,
  },
  datasets: [
    installDataset,
    earningsDataset,
    listingRatingDataset,
    reportStatusDataset,
  ],
  metrics: [],
  supportsResourceSelection: true,
  minRefreshIntervalSeconds: 6 * 60 * 60,
  supportsBackfill: true,
  backfillDays: 365,
  outboundDomains: [
    STORAGE_HOST,
    REPORTING_HOST,
    PLAY_STORE_HOST,
    PLAY_ARTWORK_HOST,
  ],
  rateLimit: { maxRequests: 600, windowSeconds: 60, scope: "connection" },
  resourceNoun: { singular: "App", plural: "Apps" },
  translations: { de },
};

function historyFrom(config: Record<string, unknown>): string | undefined {
  const raw = config.historyFrom;
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw !== "string" || !z.iso.date().safeParse(raw).success)
    throw new Error("Enter the earliest report date as YYYY-MM-DD.");
  return raw;
}

export function createGooglePlayConnector(
  options: { now?: () => number } = {},
): Connector {
  const now = options.now ?? Date.now;
  const listings = new Map<string, ListingSnapshot>();
  const listingKey = (context: ConnectionContext, id: string) =>
    JSON.stringify([listingScope(context.config), id]);
  const cacheListing = (key: string, snapshot: ListingSnapshot) => {
    listings.delete(key);
    listings.set(key, snapshot);
    // This bounds a disposable public-artwork cache, not retained app data.
    if (listings.size > 1000) listings.delete(listings.keys().next().value!);
  };
  const discover = async (
    context: ConnectionContext,
    runtime: ConnectorRuntime,
  ): Promise<Resource[]> => {
    const packages = new Map(
      manualPackages(context.config).map((id) => [
        id,
        listings.get(listingKey(context, id))?.name ?? id,
      ]),
    );
    try {
      for (const app of await accessibleApps(context, runtime))
        packages.set(app.id, app.name);
    } catch (error) {
      if (
        !(error instanceof PlayReportError) ||
        ![403, 404].includes(error.status)
      )
        throw error;
    }
    const catalog = await reportCatalog(
      createPlayReportsClient(context, runtime),
    );
    for (const id of reportedPackages(catalog.installs).filter(validPackage))
      if (!packages.has(id))
        packages.set(id, listings.get(listingKey(context, id))?.name ?? id);
    return [...packages]
      .map(([id, name]) => ({
        id,
        name,
        kind: "Android",
        metadata: { packageName: id },
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  };
  return {
    manifest: googlePlayManifest,
    async check(context, runtime): Promise<CheckResult> {
      try {
        bucketName(context.config);
        manualPackages(context.config);
        listingScope(context.config);
        historyFrom(context.config);
      } catch (error) {
        return {
          ok: false,
          message:
            error instanceof Error
              ? error.message
              : "Check the Google Play connection settings.",
        };
      }
      const client = createPlayReportsClient(context, runtime);
      const probe = async (prefix: string) => {
        try {
          const object = await client.sample(prefix);
          if (object) await client.bytes(object);
          return true;
        } catch (error) {
          if (error instanceof PlayReportError && error.status === 403)
            return false;
          throw error;
        }
      };
      try {
        const [installs, earnings] = await Promise.all([
          probe("stats/installs/"),
          probe("earnings/"),
        ]);
        if (!installs && !earnings)
          return {
            ok: false,
            message:
              "This Google account cannot read these Play reports. In Play Console, grant access to app statistics and financial data, then try again.",
          };
        return {
          ok: true,
          ...(!installs
            ? {
                message:
                  "Connected for earnings. Enable app statistics access in Play Console to read install reports.",
              }
            : !earnings
              ? {
                  message:
                    "Connected for install reports. Enable financial data access in Play Console to read earnings.",
                }
              : {}),
        };
      } catch (error) {
        if (error instanceof PlayReportError && error.status === 404)
          return {
            ok: false,
            message:
              "The Play report bucket was not found. Copy its Google Cloud Storage URI from Play Console.",
          };
        throw error;
      }
    },
    discover,
    async sync(context, request, runtime) {
      const scope = listingScope(context.config),
        start = historyFrom(context.config),
        additional = manualPackages(context.config);
      const selected = request.resources;
      if (selected?.some((id) => !validPackage(id)))
        throw new Error("Invalid Android package selection");
      const signature = createHash("sha256")
        .update(
          JSON.stringify([
            bucketName(context.config),
            scope,
            start ?? null,
            additional,
            selected ? [...new Set(selected)].sort() : null,
          ]),
        )
        .digest("hex");
      return syncPlayReports(request, runtime, {
        now: now(),
        scope,
        historyFrom: start,
        signature,
        client: createPlayReportsClient(context, runtime),
        apps: async () =>
          selected ?? (await discover(context, runtime)).map((app) => app.id),
        onListing: (id, snapshot) => {
          cacheListing(listingKey(context, id), snapshot);
        },
      });
    },
    async resourceIcons(context, request, runtime) {
      const icons: ResourceIconsResult["icons"] = [];
      const scope = listingScope(context.config);
      for (const id of request.resources.map((resource) => resource.id)) {
        if (!validPackage(id)) continue;
        const snapshot =
          listings.get(listingKey(context, id)) ??
          (await listingSnapshot(
            runtime,
            id,
            scope,
            new Date(now()).toISOString(),
          ));
        if (!snapshot.artwork) continue;
        const response = await runtime.fetch(snapshot.artwork, {
          method: "GET",
          headers: { accept: "image/png,image/jpeg,image/webp" },
        });
        if (response.status !== 200) continue;
        const contentType = response.headers["content-type"]
          ?.split(";")[0]
          ?.trim();
        if (
          contentType !== "image/png" &&
          contentType !== "image/jpeg" &&
          contentType !== "image/webp"
        )
          continue;
        const bytes = response.bytes();
        if (bytes.byteLength > RESOURCE_ICON_MAX_BYTES) continue;
        icons.push({
          resourceId: id,
          contentType,
          data: Buffer.from(bytes).toString("base64"),
        });
      }
      return { icons };
    },
  };
}
