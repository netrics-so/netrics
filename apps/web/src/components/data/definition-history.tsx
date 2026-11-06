"use client";
import { useEffect, useRef, useState } from "react";
import {
  readDefinitionHistory,
  type DefinitionHistory as History,
} from "@/lib/data-api";
import { dataErrorKey } from "@/lib/data-editing";
import { useLocale, useT } from "@/lib/i18n/client";

export function DefinitionHistory({
  workspaceId,
  kind,
  id,
  publishedVersion,
  restoredFromVersion,
  disabled,
  unsaved,
  onRestore,
  onAdoptLatest,
}: {
  workspaceId: string;
  kind: "preparations" | "models";
  id: string;
  publishedVersion: number | null;
  restoredFromVersion?: number | null;
  disabled: boolean;
  unsaved: boolean;
  onRestore: (version: number) => Promise<void>;
  onAdoptLatest: () => Promise<void>;
}) {
  const t = useT("data"),
    locale = useLocale();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<History | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  async function load(beforeVersion?: number) {
    const request = ++sequence.current;
    setLoading(true);
    setError(null);
    try {
      const next = await readDefinitionHistory(
        workspaceId,
        kind,
        id,
        beforeVersion,
      );
      if (request === sequence.current) setPage(next);
    } catch (failure) {
      if (request === sequence.current)
        setError(t(`errors.${dataErrorKey(failure)}`));
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    if (open) void load();
    return () => {
      sequence.current++;
    };
    // Reload the first page when the active publication changes.
  }, [open, publishedVersion, id]);
  return (
    <section className="data-history">
      {restoredFromVersion ? (
        <div className="stack">
          <p className="help">
            {t("restoredInputs", { version: restoredFromVersion })}
          </p>
          <div>
            <button
              type="button"
              disabled={disabled || unsaved}
              onClick={() => void onAdoptLatest()}
            >
              {t("adoptLatestInputs")}
            </button>
          </div>
        </div>
      ) : null}
      <button
        type="button"
        className="link-button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {t("versionHistory")}
      </button>
      {open ? (
        <div className="stack">
          <p className="help">{t("historyHint")}</p>
          {unsaved ? <p className="help">{t("historyUnsaved")}</p> : null}
          {loading ? (
            <p role="status" className="page-meta">
              {t("historyLoading")}
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
          {page && !loading ? (
            <>
              {!page.versions.length ? (
                <p className="page-meta">{t("historyEmpty")}</p>
              ) : (
                <ul className="data-history-list">
                  {page.versions.map((publication) => (
                    <li key={publication.version}>
                      <div>
                        <strong>
                          {t("historyVersion", {
                            version: publication.version,
                          })}
                        </strong>
                        {publication.active ? (
                          <span className="page-meta">
                            {" "}
                            · {t("historyActive")}
                          </span>
                        ) : null}
                        <p className="page-meta">
                          <time dateTime={publication.createdAt}>
                            {new Date(publication.createdAt).toLocaleString(
                              locale,
                            )}
                          </time>
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={disabled || unsaved}
                        onClick={() => void onRestore(publication.version)}
                      >
                        {t("restoreDraft")}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="data-form-actions">
                <button
                  type="button"
                  disabled={
                    disabled || page.versions[0]?.version === publishedVersion
                  }
                  onClick={() => void load()}
                >
                  {t("historyNewest")}
                </button>
                <button
                  type="button"
                  disabled={disabled || !page.nextBeforeVersion}
                  onClick={() => void load(page.nextBeforeVersion!)}
                >
                  {t("historyOlder")}
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
