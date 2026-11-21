"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type {
  CustomApiDefinition,
  CustomApiVersionHistory,
} from "@netrics/contracts";

import { useConfirmation, type Question } from "@/components/confirm-dialog";
import { apiErrorMessage } from "@/lib/api";
import { getVersion, listVersions, restoreVersion } from "@/lib/custom-api";
import { useLocale, useT } from "@/lib/i18n/client";
import { useViewerTimeZone } from "@/lib/viewer-time-zone";

import { CustomApiSummary } from "./summary";

export interface HistoryClient {
  listVersions: typeof listVersions;
  getVersion: typeof getVersion;
  restoreVersion: typeof restoreVersion;
}

const defaultHistoryClient: HistoryClient = {
  listVersions,
  getVersion,
  restoreVersion,
};

/**
 * Restoring a version (#808): asks first; a confirmed restore saves the
 * old document as a new version on top of `baseVersion` (the stale check).
 */
export async function restoreFlow(
  client: Pick<HistoryClient, "restoreVersion">,
  ask: (question: Question) => Promise<boolean>,
  input: {
    workspaceId: string;
    definitionId: string;
    version: number;
    baseVersion: number;
    question: Question;
  },
): Promise<{ restored: false } | { restored: true; currentVersion: number }> {
  if (!(await ask(input.question))) return { restored: false };
  const { definition } = await client.restoreVersion(
    input.workspaceId,
    input.definitionId,
    input.version,
    input.baseVersion,
  );
  return { restored: true, currentVersion: definition.currentVersion };
}

/**
 * A custom API's versions (#808), newest first, 20 per page: who saved
 * each and when, the earlier version a restore equals, a read-only view,
 * and "Restore this version" for members who may change it.
 */
export function VersionHistory({
  workspaceId,
  definitionId,
  currentVersion,
  canRestore,
  initial = null,
  client = defaultHistoryClient,
}: {
  workspaceId: string;
  definitionId: string;
  currentVersion: number;
  canRestore: boolean;
  /** The first page, rendered by the server. */
  initial?: CustomApiVersionHistory | null;
  client?: HistoryClient;
}) {
  const t = useT("customApi.history");
  const common = useT("common");
  const locale = useLocale();
  const timeZone = useViewerTimeZone();
  const router = useRouter();
  const { ask, dialog } = useConfirmation();
  const [page, setPage] = useState<CustomApiVersionHistory | null>(initial);
  const [before, setBefore] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{
    version: number;
    document: CustomApiDefinition;
  } | null>(null);
  const sequence = useRef(0);

  async function load(older?: number) {
    const request = ++sequence.current;
    setLoading(true);
    setError(null);
    try {
      const next = await client.listVersions(workspaceId, definitionId, older);
      if (request === sequence.current) setPage(next);
    } catch (cause) {
      if (request === sequence.current)
        setError(apiErrorMessage(cause, locale));
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (!initial) void load();
    return () => {
      sequence.current++;
    };
    // Reload when a new version arrives.
  }, [currentVersion]);

  async function view(version: number) {
    if (viewing?.version === version) return setViewing(null);
    setError(null);
    try {
      setViewing(await client.getVersion(workspaceId, definitionId, version));
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    }
  }

  async function restore(version: number) {
    setError(null);
    setNotice(null);
    try {
      const result = await restoreFlow(client, ask, {
        workspaceId,
        definitionId,
        version,
        baseVersion: currentVersion,
        question: {
          title: t("restore"),
          text: t("restoreConfirm", { version }),
          confirm: t("restore"),
          cancel: common("cancel"),
        },
      });
      if (!result.restored) return;
      setNotice(t("restored", { version, current: result.currentVersion }));
      setBefore([]);
      router.refresh();
      await load();
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    }
  }

  return (
    <section
      className="card custom-api-history"
      aria-labelledby="custom-api-history"
    >
      <h2 id="custom-api-history">{t("title")}</h2>
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <div role="alert">
          <p className="error">{error}</p>
          <button type="button" onClick={() => void load()}>
            {t("retry")}
          </button>
        </div>
      ) : null}
      {loading && !page ? (
        <p className="page-meta" role="status">
          {t("loading")}
        </p>
      ) : null}
      {page ? (
        <ul className="custom-api-history-list">
          {page.versions.map((entry) => (
            <li key={entry.id} data-version={entry.version}>
              <div>
                <strong>
                  {t("byAt", {
                    version: entry.version,
                    author: entry.author?.name ?? t("unknownAuthor"),
                    time: new Date(entry.createdAt).toLocaleString(locale, {
                      timeZone,
                    }),
                  })}
                </strong>
                {entry.current ? (
                  <span className="badge">{t("current")}</span>
                ) : null}
                <p className="page-meta">
                  {entry.sameAs !== null
                    ? `${t("sameAs", { version: entry.sameAs })} · `
                    : ""}
                  {t("summary", {
                    streams: entry.summary.streams,
                    fields: entry.summary.fields,
                  })}
                </p>
              </div>
              <div className="actions">
                <button
                  type="button"
                  aria-expanded={viewing?.version === entry.version}
                  onClick={() => void view(entry.version)}
                >
                  {viewing?.version === entry.version ? t("hide") : t("view")}
                </button>
                {canRestore && !entry.current ? (
                  <button
                    type="button"
                    onClick={() => void restore(entry.version)}
                  >
                    {t("restore")}
                  </button>
                ) : null}
              </div>
              {viewing?.version === entry.version ? (
                <CustomApiSummary definition={{ document: viewing.document }} />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {page && (before.length > 0 || page.nextBefore !== null) ? (
        <div className="actions">
          <button
            type="button"
            disabled={loading || before.length === 0}
            onClick={() => {
              const previous = before.slice(0, -1);
              setBefore(previous);
              void load(previous.at(-1));
            }}
          >
            {t("newer")}
          </button>
          <button
            type="button"
            disabled={loading || page.nextBefore === null}
            onClick={() => {
              const next = page.nextBefore!;
              setBefore([...before, next]);
              void load(next);
            }}
          >
            {t("older")}
          </button>
        </div>
      ) : null}
      {dialog}
    </section>
  );
}
