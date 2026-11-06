import { relayOAuthCallback } from "@/lib/oauth-callback";

// The OAuth redirect URI, <WEB_ORIGIN>/oauth/<provider>/callback (ADR 0012).
// Forwards the provider's query to the API, which exchanges the code; the
// browser only ever gets a 303 to an app path. See lib/oauth-callback.
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await params;
  return relayOAuthCallback(request, provider);
}
