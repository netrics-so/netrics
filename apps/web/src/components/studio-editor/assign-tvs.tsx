"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import type { Device } from "@netrics/contracts";

import { apiErrorMessage, updateDevice } from "@/lib/api";
import { useLocale, useT } from "@/lib/i18n/client";

/** The TVs whose assignment changes: newly checked or unchecked. */
export function assignmentChanges(
  devices: ReadonlyArray<Pick<Device, "id" | "dashboardId">>,
  dashboardId: string,
  checked: ReadonlySet<string>,
): Array<{ deviceId: string; dashboardId: string | null }> {
  return devices.flatMap((device) => {
    const shows = device.dashboardId === dashboardId;
    const wanted = checked.has(device.id);
    if (shows === wanted) return [];
    return [{ deviceId: device.id, dashboardId: wanted ? dashboardId : null }];
  });
}

/**
 * "Show on TVs": pick paired TVs to show this dashboard, with the existing
 * assignment (PATCH …/devices/:id). A TV shows one dashboard; checking it
 * here moves it from the one it showed. Unchecking leaves it without one.
 */
export function AssignTvs({
  open,
  workspaceId,
  dashboardId,
  dashboardName,
  devices,
  dashboardNames,
  unsaved,
  onClose,
  onAssigned,
}: {
  open: boolean;
  workspaceId: string;
  dashboardId: string;
  dashboardName: string;
  /** Active (not revoked) TVs of the workspace. */
  devices: Device[];
  dashboardNames: ReadonlyMap<string, string>;
  unsaved: boolean;
  onClose: () => void;
  onAssigned: (devices: Device[]) => void;
}) {
  const locale = useLocale();
  const t = useT("studio.assignTvs");
  const common = useT("common");
  const dialog = useRef<HTMLDialogElement>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setChecked(
        new Set(
          devices
            .filter((device) => device.dashboardId === dashboardId)
            .map((device) => device.id),
        ),
      );
      setError(null);
      element.showModal();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open, devices, dashboardId]);

  const changes = assignmentChanges(devices, dashboardId, checked);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const updated = new Map<string, Device>();
    try {
      for (const change of changes) {
        const { device } = await updateDevice(workspaceId, change.deviceId, {
          dashboardId: change.dashboardId,
        });
        updated.set(device.id, device);
      }
      onAssigned(devices.map((device) => updated.get(device.id) ?? device));
      onClose();
    } catch (cause) {
      if (updated.size > 0) {
        onAssigned(devices.map((device) => updated.get(device.id) ?? device));
      }
      setError(apiErrorMessage(cause, locale));
    } finally {
      setPending(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="studio-dialog"
      aria-labelledby="assign-title"
      onClose={onClose}
    >
      <form onSubmit={(event) => void onSubmit(event)}>
        <h2 id="assign-title">{t("title", { name: dashboardName })}</h2>
        {unsaved ? <p className="notice">{t("unsaved")}</p> : null}
        {devices.length === 0 ? (
          <p className="muted">
            {t("none")} <a href="/devices/approve">{t("connect")}</a>
          </p>
        ) : (
          <ul className="assign-list">
            {devices.map((device) => {
              const current = device.dashboardId
                ? (dashboardNames.get(device.dashboardId) ?? null)
                : null;
              const shows = device.dashboardId === dashboardId;
              return (
                <li key={device.id}>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={checked.has(device.id)}
                      onChange={(event) => {
                        const next = new Set(checked);
                        if (event.target.checked) next.add(device.id);
                        else next.delete(device.id);
                        setChecked(next);
                      }}
                    />
                    <span>
                      <strong>{device.name}</strong>{" "}
                      <span className="muted">
                        {shows
                          ? t("showsThis")
                          : device.dashboardId
                            ? current
                              ? t("showsOther", { name: current })
                              : t("showsAnother")
                            : t("showsNone")}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="actions">
          <button
            type="submit"
            className="primary"
            disabled={pending || changes.length === 0}
          >
            {pending ? t("assigning") : t("apply")}
          </button>
          <button type="button" onClick={onClose} disabled={pending}>
            {common("cancel")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
