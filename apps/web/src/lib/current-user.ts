import { headers } from "next/headers";
import { cache } from "react";

import type { MeResponse } from "@netrics/contracts";

import { getMe } from "./api";

/**
 * The signed-in user and memberships for this request, or null; one
 * /v1/me call per request however many components ask (the nav, the
 * language, the page). Requests without a session cookie skip the call.
 */
export const getCurrentMe = cache(async (): Promise<MeResponse | null> => {
  const cookieHeader = (await headers()).get("cookie") ?? "";
  if (!cookieHeader.includes("better-auth.session_token")) {
    return null;
  }
  try {
    return await getMe(cookieHeader);
  } catch {
    // The page itself reports an unreachable API; the nav and the language
    // fall back instead of failing the whole layout.
    return null;
  }
});
