import type { ReactNode } from "react";

import { Nav } from "@/components/nav";

/**
 * Pages outside a workspace (sign-in, account, status, device approval):
 * the slim top bar above one centred column. Workspace pages have the app
 * shell instead (workspaces/[workspaceId]/layout.tsx, ADR 0018 section 4).
 */
export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Nav />
      <main className="container">{children}</main>
    </>
  );
}
