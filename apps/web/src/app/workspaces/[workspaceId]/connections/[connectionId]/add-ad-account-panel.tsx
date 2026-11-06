"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import type {
  ConnectionDetail,
  SharedKeyResourcesResponse,
} from "@netrics/contracts";

import { AdAccountOption } from "../new/apple-ads-setup";
import {
  apiErrorMessage,
  createSharedKeyConnections,
  listSharedKeyResources,
} from "@/lib/api";
import { appleAdsAccountConfig, appleAdsAccounts } from "@/lib/apple-ads";
import { useLocale, useT } from "@/lib/i18n/client";

interface AddAdAccountPanelProps {
  workspaceId: string;
  connectionId: string;
}

/**
 * "Add another ad account" on an Apple Ads connection page (#395): the ad
 * accounts the stored key reads, listed by the API with that key (the key
 * never reaches the browser), those this workspace has connected marked;
 * the chosen ones become connections with the same key in one request,
 * all or none. They then share the key with this connection.
 */
export function AddAdAccountPanel({
  workspaceId,
  connectionId,
}: AddAdAccountPanelProps) {
  const locale = useLocale();
  const t = useT("connections.appleAds");
  const common = useT("common");
  const router = useRouter();
  const [listed, setListed] = useState<SharedKeyResourcesResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<"list" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<ConnectionDetail[]>([]);

  const accounts = useMemo(
    () => (listed?.check.ok ? appleAdsAccounts(listed.resources) : []),
    [listed],
  );
  const connected = useMemo(
    () =>
      new Map(
        (listed?.connected ?? []).map((entry) => [entry.resourceId, entry]),
      ),
    [listed],
  );
  const open = accounts.filter(
    (account) => account.selectable && !connected.has(account.id),
  );

  async function onList() {
    setError(null);
    setAdded([]);
    setPending("list");
    try {
      const result = await listSharedKeyResources(workspaceId, connectionId);
      setListed(result);
      setSelected(new Set());
      if (!result.check.ok) {
        setError(result.check.message ?? t("checkFailed"));
      }
    } catch (cause) {
      setListed(null);
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(null);
    }
  }

  async function onCreate() {
    setError(null);
    const chosen = open.filter((account) => selected.has(account.id));
    if (chosen.length === 0) {
      setError(t("selectAccount"));
      return;
    }
    setPending("create");
    try {
      const { connections } = await createSharedKeyConnections(
        workspaceId,
        connectionId,
        {
          connections: chosen.map((account) => ({
            name: t("connectionName", { account: account.name }).slice(0, 100),
            config: appleAdsAccountConfig(account),
          })),
        },
      );
      setAdded(connections);
      setListed(null);
      setSelected(new Set());
      // The page's "shared with" lines now name the new connections.
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(null);
    }
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  const disabled = pending !== null;

  return (
    <div className="card" id="add-ad-account">
      <h2>{t("addAccountTitle")}</h2>
      <p className="muted">{t("addAccountIntro")}</p>

      {added.length > 0 ? (
        <div className="notice" role="status">
          {t("addAccountAdded", { count: added.length })}{" "}
          {added.map((connection, index) => (
            <span key={connection.id}>
              {index > 0 ? ", " : null}
              <Link
                href={`/workspaces/${workspaceId}/connections/${connection.id}`}
              >
                {connection.name}
              </Link>
            </span>
          ))}
        </div>
      ) : null}

      {listed?.check.ok ? (
        <>
          <p className="muted">
            {t("addAccountFound", { count: accounts.length })}
          </p>
          <ul className="workspace-list ad-account-list">
            {accounts.map((account) => {
              const connection = connected.get(account.id);
              return (
                <AdAccountOption
                  key={account.id}
                  account={account}
                  checked={selected.has(account.id)}
                  disabled={disabled}
                  onToggle={() => toggle(account.id)}
                  connected={
                    connection ? (
                      <>
                        {t("addAccountConnected", {
                          name: connection.connectionName,
                        })}{" "}
                        {connection.connectionId !== connectionId ? (
                          <Link
                            href={`/workspaces/${workspaceId}/connections/${connection.connectionId}`}
                          >
                            ↗
                          </Link>
                        ) : null}
                      </>
                    ) : null
                  }
                />
              );
            })}
          </ul>
          {open.length === 0 ? (
            <p className="help">{t("addAccountNone")}</p>
          ) : null}
          <div className="actions">
            {open.length > 0 ? (
              <button
                type="button"
                className="primary"
                disabled={disabled || selected.size === 0}
                onClick={onCreate}
              >
                {pending === "create"
                  ? t("creating")
                  : t("addAccountCreate", {
                      count: Math.max(selected.size, 1),
                    })}
              </button>
            ) : null}
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                setListed(null);
                setSelected(new Set());
                setError(null);
              }}
            >
              {common("cancel")}
            </button>
          </div>
        </>
      ) : (
        <div className="actions">
          <button type="button" disabled={disabled} onClick={onList}>
            {pending === "list"
              ? t("addAccountLoading")
              : t("addAccountButton")}
          </button>
        </div>
      )}

      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
