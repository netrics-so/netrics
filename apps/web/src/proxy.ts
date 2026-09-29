import { NextResponse, type NextRequest } from "next/server";

import {
  canonicalHostConfig,
  canonicalHostRedirect,
} from "@/lib/canonical-host";
import { pairingHostConfig, pairingHostRedirect } from "@/lib/pairing-host";

/**
 * Runs before every route. Requests on the hosted pairing domain
 * (NETRICS_PAIRING_HOST) go to the approval page on NETRICS_APP_ORIGIN;
 * requests on any other host than the app origin's go to the same path
 * there (lib/canonical-host has the exemptions); all others pass through.
 * The Host header is used as received: the web app trusts no
 * forwarded-host header.
 */
export function proxy(request: NextRequest) {
  const host = request.headers.get("host");
  const pairing = pairingHostRedirect(
    pairingHostConfig(process.env),
    host,
    request.nextUrl,
  );
  if (pairing) {
    // 302, not permanent: codes are single-use and the target may change.
    const response = NextResponse.redirect(pairing, 302);
    response.headers.set("cache-control", "no-store");
    return response;
  }
  const canonical = canonicalHostRedirect(
    canonicalHostConfig(process.env),
    host,
    request.nextUrl,
  );
  if (canonical) {
    // 308 keeps the method and body; no-store keeps a wrong
    // NETRICS_APP_ORIGIN from sticking in browsers once it is fixed.
    const response = NextResponse.redirect(canonical, 308);
    response.headers.set("cache-control", "no-store");
    return response;
  }
  return NextResponse.next();
}
