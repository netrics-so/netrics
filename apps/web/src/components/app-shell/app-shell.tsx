"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import {
  activeNavKey,
  isNavPage,
  shellVariant,
  workspaceNav,
  workspacePath,
  type NavItem,
  type NavKey,
  type NavPermissions,
  type NavSection,
} from "@/lib/app-nav";
import { signOut } from "@/lib/auth";
import { useT } from "@/lib/i18n/client";

import { Chevron, MenuIcon, NavIcon } from "./nav-icon";

export interface AppShellProps {
  workspaceId: string;
  /** The user's workspaces, for the switcher; the current one among them. */
  workspaces: readonly { id: string; name: string }[];
  userName: string;
  permissions: NavPermissions;
  /** How many connections the workspace has, and how many need attention. */
  sourceCount: number;
  attention: number;
  children: ReactNode;
}

/**
 * The workspace app shell (ADR 0018 section 4, #302): the full-sitemap
 * sidebar and the top bar around every workspace page; the Studio gets the
 * 56 px icon rail, TV mode no chrome at all. Phones get the sidebar as a
 * drawer behind a menu button.
 */
export function AppShell(props: AppShellProps) {
  return <AppShellFrame {...props} pathname={usePathname() ?? ""} />;
}

/** The shell for a given path (AppShell reads it from the router). */
export function AppShellFrame({
  pathname,
  children,
  ...props
}: AppShellProps & { pathname: string }) {
  const variant = shellVariant(pathname);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Navigating closes the phone drawer.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  if (variant === "none") {
    return <>{children}</>;
  }
  const active = activeNavKey(pathname, props.workspaceId);
  const items = workspaceNav(props.workspaceId, props.permissions);

  if (variant === "rail") {
    return (
      <div className="app-shell app-shell--rail">
        <IconRail {...props} items={items} active={active} />
        <main id="main" className="shell-content shell-content--full">
          {children}
        </main>
      </div>
    );
  }

  return (
    <div
      className={`app-shell${drawerOpen ? " app-shell--drawer-open" : ""}`}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === "Escape" && drawerOpen) {
          setDrawerOpen(false);
        }
      }}
    >
      <Sidebar
        {...props}
        items={items}
        active={active}
        pathname={pathname}
        onClose={() => setDrawerOpen(false)}
      />
      {drawerOpen ? (
        <div
          className="shell-backdrop"
          aria-hidden="true"
          onClick={() => setDrawerOpen(false)}
        />
      ) : null}
      <div className="shell-body">
        <TopBar
          {...props}
          drawerOpen={drawerOpen}
          onToggleDrawer={() => setDrawerOpen((open) => !open)}
        />
        <main id="main" className="shell-content">
          {children}
        </main>
      </div>
    </div>
  );
}

type ShellParts = Omit<AppShellProps, "children">;

const SECTIONS: readonly NavSection[] = ["dashboards", "sources", "screens"];

function Sidebar({
  workspaceId,
  workspaces,
  items,
  active,
  pathname,
  attention,
  onClose,
}: ShellParts & {
  items: NavItem[];
  active: NavKey | null;
  pathname: string;
  onClose: () => void;
}) {
  const t = useT("shell");
  const row = (item: NavItem) => (
    <li key={item.key}>
      <Link
        href={item.href}
        className={`shell-nav-row${item.section ? " shell-nav-row--sub" : ""}`}
        aria-current={
          item.key === active
            ? isNavPage(pathname, item)
              ? "page"
              : "true"
            : undefined
        }
      >
        <span className="shell-nav-label">{t(`items.${item.key}`)}</span>
        {item.key === "sources" && attention > 0 ? (
          <span
            className="shell-attention-dot"
            role="img"
            aria-label={t("attentionDot")}
          />
        ) : null}
      </Link>
    </li>
  );
  const top = items.filter((item) => item.section === null);
  const [home, ...bottom] = top;

  return (
    <aside id="shell-sidebar" className="shell-sidebar">
      <div className="shell-brand-row">
        <Link href={workspacePath(workspaceId)} className="shell-brand">
          <span className="brand-dot" aria-hidden="true" />
          netrics
        </Link>
        <button
          type="button"
          className="shell-drawer-close"
          aria-label={t("closeMenu")}
          onClick={onClose}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <WorkspaceSwitcher workspaceId={workspaceId} workspaces={workspaces} />
      <nav className="shell-nav" aria-label={t("sidebar")}>
        <ul className="shell-nav-list">
          {home ? row(home) : null}
          {SECTIONS.map((section) => {
            const sectionItems = items.filter(
              (item) => item.section === section,
            );
            if (sectionItems.length === 0) {
              return null;
            }
            return (
              <li key={section} className="shell-nav-section">
                <span
                  className="shell-nav-section-label"
                  id={`shell-section-${section}`}
                >
                  {t(`sections.${section}`)}
                </span>
                <ul aria-labelledby={`shell-section-${section}`}>
                  {sectionItems.map(row)}
                </ul>
              </li>
            );
          })}
        </ul>
        <ul className="shell-nav-list shell-nav-list--bottom">
          {bottom.map(row)}
        </ul>
      </nav>
    </aside>
  );
}

function WorkspaceSwitcher({
  workspaceId,
  workspaces,
}: Pick<ShellParts, "workspaceId" | "workspaces">) {
  const t = useT("shell.workspace");
  const current = workspaces.find((w) => w.id === workspaceId);
  const name = current?.name ?? "";
  return (
    <Menu
      className="workspace-switcher"
      summaryLabel={t("switcher", { name })}
      summary={
        <>
          <span className="workspace-switcher-name">{name}</span>
          <Chevron />
        </>
      }
    >
      <p className="shell-menu-label" id="workspace-switcher-list">
        {t("list")}
      </p>
      <ul aria-labelledby="workspace-switcher-list">
        {workspaces.map((workspace) => (
          <li key={workspace.id}>
            <Link
              href={workspacePath(workspace.id)}
              className="shell-menu-item"
              aria-current={workspace.id === workspaceId ? "true" : undefined}
            >
              <span className="shell-menu-item-label">{workspace.name}</span>
              {workspace.id === workspaceId ? (
                <span className="shell-menu-meta">{t("current")}</span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
      <Link href="/?new=1" className="shell-menu-item shell-menu-item--new">
        <span aria-hidden="true">+</span>
        <span className="shell-menu-item-label">{t("new")}</span>
      </Link>
    </Menu>
  );
}

function TopBar({
  workspaceId,
  userName,
  sourceCount,
  attention,
  drawerOpen,
  onToggleDrawer,
}: ShellParts & { drawerOpen: boolean; onToggleDrawer: () => void }) {
  const t = useT("shell");
  return (
    <header className="shell-topbar">
      <button
        type="button"
        className="shell-menu-button"
        aria-label={drawerOpen ? t("closeMenu") : t("openMenu")}
        aria-expanded={drawerOpen}
        aria-controls="shell-sidebar"
        onClick={onToggleDrawer}
      >
        <MenuIcon />
      </button>
      <Link
        href={workspacePath(workspaceId)}
        className="shell-brand shell-brand--topbar"
      >
        <span className="brand-dot" aria-hidden="true" />
        netrics
      </Link>
      <div className="shell-topbar-end">
        <SourceHealth
          workspaceId={workspaceId}
          sourceCount={sourceCount}
          attention={attention}
        />
        <AccountMenu userName={userName} />
      </div>
    </header>
  );
}

/** "All sources fresh" or "N sources need attention", linking to Sources. */
export function SourceHealth({
  workspaceId,
  sourceCount,
  attention,
}: Pick<ShellParts, "workspaceId" | "sourceCount" | "attention">) {
  const t = useT("shell.health");
  const state =
    attention > 0 ? "attention" : sourceCount > 0 ? "fresh" : "none";
  return (
    <Link
      href={workspacePath(workspaceId, "sources")}
      className={`source-health source-health--${state}`}
    >
      <span className="source-health-dot" aria-hidden="true" />
      <span className="source-health-text">
        {state === "attention"
          ? t("attention", { count: attention })
          : state === "fresh"
            ? t("fresh")
            : t("none")}
      </span>
    </Link>
  );
}

function AccountMenu({
  userName,
  rail = false,
}: {
  userName: string;
  rail?: boolean;
}) {
  const t = useT("shell.account");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const initial = userName.trim().charAt(0).toLocaleUpperCase() || "?";

  async function onSignOut() {
    setPending(true);
    await signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <Menu
      className={`account-menu${rail ? " account-menu--rail" : ""}`}
      summaryLabel={t("menu", { name: userName })}
      summary={
        <>
          <span className="avatar" aria-hidden="true">
            {initial}
          </span>
          {rail ? null : <span className="account-menu-name">{userName}</span>}
        </>
      }
    >
      <p className="shell-menu-label">{userName}</p>
      <ul>
        <li>
          <Link href="/settings/account" className="shell-menu-item">
            {t("settings")}
          </Link>
        </li>
        <li>
          <Link href="/status" className="shell-menu-item">
            {t("status")}
          </Link>
        </li>
        <li>
          <button
            type="button"
            className="shell-menu-item shell-menu-item--danger"
            disabled={pending}
            onClick={onSignOut}
          >
            {pending ? t("signingOut") : t("signOut")}
          </button>
        </li>
      </ul>
    </Menu>
  );
}

/**
 * A disclosure menu (`<details>`): keyboard-operable as is; Escape, a
 * click outside or choosing an entry closes it.
 */
function Menu({
  className,
  summary,
  summaryLabel,
  children,
}: {
  className: string;
  summary: ReactNode;
  summaryLabel: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const details = ref.current;
      if (details?.open && !details.contains(event.target as Node)) {
        details.open = false;
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  function close(focusSummary: boolean) {
    const details = ref.current;
    if (details) {
      details.open = false;
      if (focusSummary) {
        details.querySelector("summary")?.focus();
      }
    }
  }

  return (
    <details
      ref={ref}
      className={`shell-menu ${className}`}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === "Escape" && ref.current?.open) {
          event.stopPropagation();
          close(true);
        }
      }}
      onClick={(event: MouseEvent) => {
        if ((event.target as Element).closest("a")) {
          close(false);
        }
      }}
    >
      <summary aria-label={summaryLabel}>{summary}</summary>
      <div className="shell-menu-panel">{children}</div>
    </details>
  );
}

/** Area icons only, in the Studio (design 3b); labels as tooltips. */
const RAIL_KEYS: readonly NavKey[] = [
  "home",
  "dashboards",
  "sources",
  "screens",
  "team",
  "settings",
];

/** The area a rail button stands for (Themes under Dashboards, …). */
function railArea(key: NavKey | null): NavKey | null {
  switch (key) {
    case "themes":
      return "dashboards";
    case "addSource":
      return "sources";
    default:
      return key;
  }
}

function IconRail({
  workspaceId,
  userName,
  attention,
  items,
  active,
}: ShellParts & { items: NavItem[]; active: NavKey | null }) {
  const t = useT("shell");
  const area = railArea(active);
  const byKey = new Map(items.map((item) => [item.key, item]));
  return (
    <aside className="shell-rail">
      <Link
        href={workspacePath(workspaceId)}
        className="shell-rail-brand"
        aria-label={t("home")}
      >
        <span className="brand-dot" aria-hidden="true" />
      </Link>
      <nav aria-label={t("rail")}>
        <ul className="shell-rail-list">
          {RAIL_KEYS.flatMap((key) => {
            const item = byKey.get(key);
            if (!item) {
              return [];
            }
            const label = t(`railItems.${key}`);
            return [
              <li key={key}>
                <Link
                  href={item.href}
                  className="shell-rail-button"
                  aria-label={label}
                  title={label}
                  aria-current={key === area ? "true" : undefined}
                >
                  <NavIcon name={key} />
                  {key === "sources" && attention > 0 ? (
                    <span className="shell-attention-dot" aria-hidden="true" />
                  ) : null}
                </Link>
              </li>,
            ];
          })}
        </ul>
      </nav>
      <AccountMenu userName={userName} rail />
    </aside>
  );
}
