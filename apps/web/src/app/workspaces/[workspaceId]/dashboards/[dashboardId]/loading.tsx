export default function Loading() {
  return (
    <div className="dashboard-page" aria-busy="true">
      <p className="muted">Loading dashboard…</p>
      <div className="tile-grid">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="tile tile-skeleton" />
        ))}
      </div>
    </div>
  );
}
