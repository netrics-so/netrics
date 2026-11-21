"use client";

import { Fragment } from "react";

import type { CustomApiRequestLogEntry } from "@netrics/contracts";

import { useLocale, useT } from "@/lib/i18n/client";

/** The pages a test request read: method, URL as the server redacted it, status, time, size. */
export function RequestLog({
  log,
}: {
  log: readonly CustomApiRequestLogEntry[];
}) {
  const t = useT("customApi.log");
  const locale = useLocale();
  if (log.length === 0) return null;
  const kb = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  return (
    <div className="custom-api-log">
      <h3>{t("title")}</h3>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>{t("columns.page")}</th>
              <th>{t("columns.method")}</th>
              <th>{t("columns.status")}</th>
              <th>{t("columns.time")}</th>
              <th>{t("columns.size")}</th>
            </tr>
          </thead>
          <tbody>
            {log.map((entry) => (
              <Fragment key={entry.page}>
                <tr className="custom-api-log-entry">
                  <td>{entry.page}</td>
                  <td>{entry.method}</td>
                  <td
                    className={
                      entry.status !== null && entry.status < 400
                        ? undefined
                        : "custom-api-log-failed"
                    }
                  >
                    {entry.status ?? "–"}
                  </td>
                  <td>{t("ms", { ms: entry.durationMs })}</td>
                  <td>{t("kb", { kb: kb.format(entry.bytes / 1024) })}</td>
                </tr>
                {/* The URL as the server redacted it, on its own line. */}
                <tr className="custom-api-log-url">
                  <td colSpan={5}>
                    <span className="visually-hidden">
                      {t("columns.url")}:{" "}
                    </span>
                    <code>{entry.url}</code>
                  </td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
