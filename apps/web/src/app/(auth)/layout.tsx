import Link from "next/link";
import type { ReactNode } from "react";

import "@/app/styles/auth.css";

/**
 * Sign-in, sign-up, password reset, invitations and first setup (#308,
 * design 1e): the brand above one centred 360 px card on paper, without the
 * site's top bar. The URLs are unchanged; the route group only swaps the
 * layout.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="auth-page">
      <div className="auth-column">
        <Link href="/" className="auth-brand">
          <span className="brand-dot" aria-hidden="true" />
          netrics
        </Link>
        <div className="auth-card">{children}</div>
      </div>
    </main>
  );
}
