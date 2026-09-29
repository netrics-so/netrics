import { NextResponse, type NextRequest } from "next/server";

import { pairingHostConfig, pairingHostRedirect } from "@/lib/pairing-host";

/**
 * Runs before every route. Requests on the hosted pairing domain
 * (NETRICS_PAIRING_HOST) go to the approval page on NETRICS_APP_ORIGIN; all
 * others pass through. The Host header is used as received: the web app
 * trusts no forwarded-host header.
 */
export function proxy(request: NextRequest) {
  const location = pairingHostRedirect(
    pairingHostConfig(process.env),
    request.headers.get("host"),
    request.nextUrl,
  );
  if (!location) return NextResponse.next();
  // 302, not permanent: codes are single-use and the target may change.
  const response = NextResponse.redirect(location, 302);
  response.headers.set("cache-control", "no-store");
  return response;
}
