import type { Metadata } from "next";

import { fetchApiHealth } from "@/lib/api";
import { buildInfo } from "@/lib/build-info";
import { getLocale, getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

function StatusValue({
  state,
  text,
}: {
  state: "up" | "down" | "unknown";
  text: string;
}) {
  return (
    <span className="value">
      <span className={`dot ${state}`} />
      {text}
    </span>
  );
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("statusPage");
  return { title: `${t("title")} · netrics` };
}

export default async function StatusPage() {
  const [health, t, locale] = await Promise.all([
    fetchApiHealth(),
    getT("statusPage"),
    getLocale(),
  ]);

  const liveState = health.live ? "up" : "down";
  const readyState = health.ready
    ? health.ready.status === "ready"
      ? "up"
      : "down"
    : "unknown";
  const databaseState = health.ready
    ? health.ready.database === "up"
      ? "up"
      : "down"
    : "unknown";

  const { version: webVersion, commit: webCommit } = buildInfo();
  const apiVersion = health.live ? health.live.version : t("unknown");
  const apiCommit = health.live ? health.live.commit : t("unknown");

  return (
    <>
      <h1>{t("title")}</h1>
      <p className="subtitle">{t("subtitle")}</p>

      <div className="card">
        <div className="row">
          <span className="label">{t("webVersion")}</span>
          <span className="value">
            {webVersion} ({webCommit})
          </span>
        </div>
        <div className="row">
          <span className="label">{t("apiVersion")}</span>
          <span className="value">
            {apiVersion} ({apiCommit})
          </span>
        </div>
        <div className="row">
          <span className="label">{t("apiLive")}</span>
          <StatusValue
            state={liveState}
            text={health.live ? t("live") : t("unreachable")}
          />
        </div>
        <div className="row">
          <span className="label">{t("apiReady")}</span>
          <StatusValue
            state={readyState}
            text={
              health.ready
                ? health.ready.status === "ready"
                  ? t("ready")
                  : t("notReady")
                : t("unknown")
            }
          />
        </div>
        <div className="row">
          <span className="label">{t("database")}</span>
          <StatusValue
            state={databaseState}
            text={
              health.ready
                ? health.ready.database === "up"
                  ? t("up")
                  : t("down")
                : t("unknown")
            }
          />
        </div>
      </div>

      {health.error ? (
        <div className="error">
          {t("apiUnreachable", { error: health.error })}
        </div>
      ) : null}

      <p className="meta">
        {t("renderedAt", {
          time: new Intl.DateTimeFormat(locale, {
            dateStyle: "medium",
            timeStyle: "medium",
          }).format(new Date()),
        })}
      </p>
    </>
  );
}
