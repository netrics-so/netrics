import { headers } from "next/headers";
import Link from "next/link";

import { getSessionUser } from "@/lib/session";

export async function Nav() {
  const cookieHeader = (await headers()).get("cookie") ?? "";
  const user = await getSessionUser(cookieHeader);

  return (
    <header className="container nav">
      <Link href="/" className="nav-brand">
        netrics
      </Link>
      <nav className="nav-links">
        <Link href="/status">Status</Link>
        {user ? (
          <Link href="/settings/account">{user.name}</Link>
        ) : (
          <Link href="/login">Sign in</Link>
        )}
      </nav>
    </header>
  );
}
