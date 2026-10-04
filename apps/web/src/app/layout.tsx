import type { Metadata } from "next";
import type { ReactNode } from "react";

import { DeployWatcher } from "@/components/deploy-watcher";
import { Nav } from "@/components/nav";
import { WEB_CATALOGS } from "@/lib/i18n/catalogs";
import { I18nProvider } from "@/lib/i18n/client";
import { getLocale, getT } from "@/lib/i18n/server";

import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("appMeta");
  return { title: "netrics", description: t("description") };
}

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  const locale = await getLocale();
  return (
    <html lang={locale}>
      <body>
        <I18nProvider locale={locale} messages={WEB_CATALOGS[locale]}>
          <Nav />
          <main className="container">{children}</main>
          <DeployWatcher />
        </I18nProvider>
      </body>
    </html>
  );
}
