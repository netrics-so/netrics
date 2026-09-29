import type { Metadata } from "next";

import { KioskView } from "./kiosk-view";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "netrics kiosk",
  robots: { index: false },
};

/**
 * A browser on any screen as a netrics TV (#59): pairs like the tvOS app
 * and shows its dashboard from the device API. No user session: the
 * device credentials live in this browser's localStorage.
 */
export default function KioskPage() {
  return (
    <KioskView appVersion={process.env.NEXT_PUBLIC_APP_VERSION || "web"} />
  );
}
