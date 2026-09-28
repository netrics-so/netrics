"use client";

import Link from "next/link";

/** A failed page load; individual tiles handle their own errors. */
export default function DashboardError({ reset }: { reset: () => void }) {
  return (
    <div className="dashboard-page">
      <div className="error" role="alert">
        This dashboard could not be loaded.{" "}
        <button type="button" onClick={reset}>
          Try again
        </button>
      </div>
      <p className="muted">
        <Link href="/">Back to your workspaces</Link>
      </p>
    </div>
  );
}
