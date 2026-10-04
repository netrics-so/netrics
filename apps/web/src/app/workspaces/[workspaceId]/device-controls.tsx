"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { apiErrorMessage, revokeDevice, updateDevice } from "@/lib/api";
import { useLocale } from "@/lib/i18n/client";

interface DeviceControlsProps {
  workspaceId: string;
  device: { id: string; name: string; dashboardId: string | null };
  dashboards: Array<{ id: string; name: string }>;
}

/** Rename, reassign and revoke one active TV (owners and admins). */
export function DeviceControls({
  workspaceId,
  device,
  dashboards,
}: DeviceControlsProps) {
  const locale = useLocale();
  const router = useRouter();
  const [name, setName] = useState(device.name);
  const [dashboardId, setDashboardId] = useState(device.dashboardId ?? "");
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const changed =
    (trimmed !== "" && trimmed !== device.name) ||
    dashboardId !== (device.dashboardId ?? "");

  async function run(action: () => Promise<unknown>) {
    setError(null);
    setPending(true);
    try {
      await action();
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(false);
    }
  }

  function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Send only what changed, so a rename never reassigns and vice versa.
    void run(() =>
      updateDevice(workspaceId, device.id, {
        ...(trimmed !== "" && trimmed !== device.name ? { name: trimmed } : {}),
        ...(dashboardId !== (device.dashboardId ?? "")
          ? { dashboardId: dashboardId || null }
          : {}),
      }),
    );
  }

  function onRevoke() {
    setConfirming(false);
    void run(() => revokeDevice(workspaceId, device.id));
  }

  return (
    <>
      <form className="inline" onSubmit={onSave}>
        <div className="field">
          <label htmlFor={`device-${device.id}-name`}>Name</label>
          <input
            id={`device-${device.id}-name`}
            type="text"
            value={name}
            required
            maxLength={100}
            disabled={pending}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`device-${device.id}-dashboard`}>Dashboard</label>
          <select
            id={`device-${device.id}-dashboard`}
            value={dashboardId}
            disabled={pending}
            onChange={(event) => setDashboardId(event.target.value)}
          >
            {dashboards.map((dashboard) => (
              <option key={dashboard.id} value={dashboard.id}>
                {dashboard.name}
              </option>
            ))}
            <option value="">No dashboard</option>
          </select>
        </div>
        <button type="submit" disabled={pending || !changed}>
          Save
        </button>
      </form>
      {confirming ? (
        <div className="actions">
          <span>Revoke {device.name}? It stops showing data immediately.</span>
          <button
            type="button"
            className="danger"
            disabled={pending}
            onClick={onRevoke}
          >
            Confirm
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="actions">
          <button
            type="button"
            className="danger"
            disabled={pending}
            onClick={() => setConfirming(true)}
          >
            Revoke
          </button>
        </div>
      )}
      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
    </>
  );
}
