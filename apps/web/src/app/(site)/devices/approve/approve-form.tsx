"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { apiErrorMessage, approveDevice, lookupPairing } from "@/lib/api";
import { completePairingCode } from "@/lib/device-platform";
import { useLocale, useT } from "@/lib/i18n/client";

/** The format of a pairing code, as the TV shows it. */
const CODE_PLACEHOLDER = "XXXX-XXXX";

export interface ApprovableWorkspace {
  id: string;
  name: string;
  dashboards: Array<{ id: string; name: string }>;
}

interface ApproveDeviceFormProps {
  initialCode: string;
  workspaces: ApprovableWorkspace[];
}

export function ApproveDeviceForm({
  initialCode,
  workspaces,
}: ApproveDeviceFormProps) {
  const locale = useLocale();
  const t = useT("deviceApproval");
  const [code, setCode] = useState(initialCode);
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]!.id);
  const workspace = workspaces.find((w) => w.id === workspaceId)!;
  const [dashboardId, setDashboardId] = useState(
    workspace.dashboards[0]?.id ?? "",
  );
  // Apple TV until the code's device says otherwise (#406); apps before
  // it report no platform.
  const [name, setName] = useState(() => t("names.tvos"));
  const [nameEdited, setNameEdited] = useState(false);
  const lookedUp = useRef<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paired, setPaired] = useState<string | null>(null);

  // Once the code is complete, suggest a name by the platform its device
  // reported, unless the name was typed. Each code is looked up once: a
  // miss counts as a failed approval on the server.
  const latest = useRef({ code, nameEdited });
  latest.current = { code, nameEdited };
  useEffect(() => {
    const complete = completePairingCode(code);
    if (nameEdited || complete === null || lookedUp.current === complete) {
      return;
    }
    lookedUp.current = complete;
    lookupPairing(complete)
      .then(({ pairing }) => {
        const now = latest.current;
        if (
          pairing.platform &&
          !now.nameEdited &&
          completePairingCode(now.code) === complete
        ) {
          setName(t(`names.${pairing.platform}`));
        }
      })
      // The approval reports a wrong or expired code; the name stays.
      .catch(() => undefined);
  }, [code, nameEdited, t]);

  function selectWorkspace(id: string) {
    setWorkspaceId(id);
    const next = workspaces.find((w) => w.id === id)!;
    setDashboardId(next.dashboards[0]?.id ?? "");
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const { device } = await approveDevice(workspaceId, {
        code,
        name: name.trim() || "TV",
        dashboardId: dashboardId || null,
      });
      setPaired(device.name);
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(false);
    }
  }

  if (paired) {
    return (
      <div className="pairing-done" role="status">
        <svg
          className="pairing-done-mark"
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="12" cy="12" r="12" fill="currentColor" />
          <path
            d="M7 12.5l3.2 3.2L17 9"
            fill="none"
            stroke="#ffffff"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <div>
          <p className="pairing-done-title">
            {t("connected", { name: paired })}
          </p>
          <p className="pairing-done-text">{t("showsSoon")}</p>
        </div>
      </div>
    );
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="pairing-code">{t("code")}</label>
        <input
          id="pairing-code"
          className="pairing-code-input"
          type="text"
          value={code}
          required
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder={CODE_PLACEHOLDER}
          maxLength={20}
          disabled={pending}
          onChange={(event) => setCode(event.target.value)}
        />
      </div>
      {workspaces.length > 1 ? (
        <div className="field">
          <label htmlFor="pairing-workspace">{t("workspace")}</label>
          <select
            id="pairing-workspace"
            value={workspaceId}
            disabled={pending}
            onChange={(event) => selectWorkspace(event.target.value)}
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="field">
        <label htmlFor="pairing-dashboard">{t("dashboard")}</label>
        <select
          id="pairing-dashboard"
          value={dashboardId}
          disabled={pending}
          onChange={(event) => setDashboardId(event.target.value)}
        >
          {workspace.dashboards.map((dashboard) => (
            <option key={dashboard.id} value={dashboard.id}>
              {dashboard.name}
            </option>
          ))}
          <option value="">{t("noDashboard")}</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="pairing-name">{t("name")}</label>
        <input
          id="pairing-name"
          type="text"
          value={name}
          maxLength={100}
          disabled={pending}
          onChange={(event) => {
            setNameEdited(true);
            setName(event.target.value);
          }}
        />
        <p className="help">{t("nameExample")}</p>
      </div>
      <div className="actions">
        <button type="submit" className="primary" disabled={pending}>
          {pending ? t("connecting") : t("connect")}
        </button>
      </div>
      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
    </form>
  );
}
