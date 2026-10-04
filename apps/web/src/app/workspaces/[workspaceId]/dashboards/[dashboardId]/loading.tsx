import { getT } from "@/lib/i18n/server";

export default async function Loading() {
  const t = await getT("dashboard");
  return (
    <div className="dashboard-page" aria-busy="true">
      <p className="muted">{t("loading")}</p>
      <div className="tile-grid">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="tile tile-skeleton" />
        ))}
      </div>
    </div>
  );
}
