import { fetchApiHealth } from "@/lib/api";

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

export default async function StatusPage() {
  const health = await fetchApiHealth();

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

  const webVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0-dev";
  const webCommit = process.env.NEXT_PUBLIC_GIT_SHA ?? "dev";
  const apiVersion = health.live ? health.live.version : "unknown";
  const apiCommit = health.live ? health.live.commit : "unknown";

  return (
    <>
      <h1>Status</h1>
      <p className="subtitle">API status — milestone 00 foundation check</p>

      <div className="card">
        <div className="row">
          <span className="label">Web version</span>
          <span className="value">
            {webVersion} ({webCommit})
          </span>
        </div>
        <div className="row">
          <span className="label">API version</span>
          <span className="value">
            {apiVersion} ({apiCommit})
          </span>
        </div>
        <div className="row">
          <span className="label">API process (live)</span>
          <StatusValue
            state={liveState}
            text={health.live ? "live" : "unreachable"}
          />
        </div>
        <div className="row">
          <span className="label">API readiness</span>
          <StatusValue
            state={readyState}
            text={health.ready ? health.ready.status : "unknown"}
          />
        </div>
        <div className="row">
          <span className="label">PostgreSQL</span>
          <StatusValue
            state={databaseState}
            text={health.ready ? health.ready.database : "unknown"}
          />
        </div>
      </div>

      {health.error ? (
        <div className="error">API unreachable: {health.error}</div>
      ) : null}

      <p className="meta">
        Rendered server-side at {new Date().toISOString()} — refresh to
        re-check.
      </p>
    </>
  );
}
