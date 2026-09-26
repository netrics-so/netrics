import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

function apiBaseUrl(): string {
  return process.env.NETRICS_API_URL ?? "http://localhost:3001";
}

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
 * incoming cookie header forwarded verbatim. Returns null when there is no
 * valid session.
 */
export async function getSessionUser(
  cookieHeader: string,
): Promise<SessionUser | null> {
  try {
    const response = await fetch(`${apiBaseUrl()}/api/auth/get-session`, {
      headers: { cookie: cookieHeader },
      cache: "no-store",
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
 * session, otherwise returns the forwarded cookie header (for /v1 fetches)
 * and the session user.
 */
export async function requireSession(): Promise<{
  cookieHeader: string;
  user: SessionUser;
}> {
  const cookieHeader = (await headers()).get("cookie") ?? "";
  const user = await getSessionUser(cookieHeader);
  if (!user) {
    redirect("/login");
  }
  return { cookieHeader, user };
}
