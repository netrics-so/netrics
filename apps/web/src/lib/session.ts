import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { apiFetch, forwardedHeaders } from "./api-fetch";

const getSessionResponseSchema = z
  .object({
    user: z.object({
      id: z.string().min(1),
      email: z.string().min(1),
      name: z.string(),
    }),
  })
  .nullable();

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

/**
 * Server-side session check: asks the API's better-auth handler with the
 * incoming request's forwarded headers (cookie verbatim, Accept-Language).
 * Returns null when there is no valid session.
 */
export async function getSessionUser(
  forwarded: Headers,
): Promise<SessionUser | null> {
  try {
    const response = await apiFetch("/api/auth/get-session", {
      headers: forwarded,
    });
    if (!response.ok) {
      return null;
    }
    const parsed = getSessionResponseSchema.safeParse(
      await response.json().catch(() => null),
    );
    return parsed.success && parsed.data ? parsed.data.user : null;
  } catch {
    return null;
  }
}

/**
 * Guard for authenticated pages: redirects to /login when there is no valid
 * session, otherwise returns the headers to forward on /v1 fetches (cookie
 * and Accept-Language, #770) and the session user.
 */
export async function requireSession(): Promise<{
  forwarded: Headers;
  user: SessionUser;
}> {
  const forwarded = forwardedHeaders(await headers());
  const user = await getSessionUser(forwarded);
  if (!user) {
    redirect("/login");
  }
  return { forwarded, user };
}
