import { getT } from "@/lib/i18n/server";
export default async function LoadingData() {
  const t = await getT("data");
  return (
    <div className="area-page" aria-busy="true">
      <h1>{t("title")}</h1>
      <p role="status">{t("loading")}</p>
    </div>
  );
}
