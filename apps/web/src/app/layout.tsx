import type { Metadata } from "next";
import type { ReactNode } from "react";

import { DeployWatcher } from "@/components/deploy-watcher";
import { Nav } from "@/components/nav";

import "./globals.css";

export const metadata: Metadata = {
  title: "netrics",
  description: "netrics — metrics on every screen",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <main className="container">{children}</main>
        <DeployWatcher />
      </body>
    </html>
  );
}
