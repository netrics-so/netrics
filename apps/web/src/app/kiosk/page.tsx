import type { Metadata } from "next";

import { getT } from "@/lib/i18n/server";

import { KioskView } from "./kiosk-view";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("screen.kiosk");
  return { title: t("title"), robots: { index: false } };
}

/**
 * A browser on any screen as a netrics TV (#59): pairs like the tvOS app
 * and shows its dashboard from the device API. No user session: the
 * device credentials live in this browser's localStorage.
 */
export default function KioskPage() {
  return <KioskView appVersion={process.env.NEXT_PUBLIC_APP_VERSION ?? ""} />;
}
