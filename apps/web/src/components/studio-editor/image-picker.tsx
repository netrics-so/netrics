"use client";

import {
  useEffect,
  useState,
  useSyncExternalStore,
  type DragEvent,
} from "react";

import {
  IMAGE_CONTENT_TYPES,
  IMAGE_MAX_BYTES,
  type ResourceIconSource,
  type WorkspaceImage,
} from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import {
  apiErrorMessage,
  fetchResourceIcon,
  listResourceIcons,
} from "@/lib/api";
import { useLocale } from "@/lib/i18n/client";

/** A workspace image as the pickers list it. */
export interface PickableImage {
  id: string;
  name: string;
  url: string;
  width: number;
  height: number;
}

/**
 * Why a file cannot be uploaded, checked before it is sent (the server
 * checks again, strictly), or null.
 */
export function uploadProblem(file: { type: string; size: number }) {
  if (!(IMAGE_CONTENT_TYPES as readonly string[]).includes(file.type)) {
    return "Choose a PNG, JPEG or WebP image.";
  }
  if (file.size > IMAGE_MAX_BYTES) {
    return "That image is larger than 1 MiB. Export it smaller and try again.";
  }
  return null;
}

interface ResourceIconsState {
  workspaceId: string | null;
  sources: ResourceIconSource[];
  onImage: ((image: WorkspaceImage) => void) | null;
}

// "Use app icon" (#226) for every image picker of the open studio. A small
// store rather than a context provider, so the editor only registers
// itself (one studio per page) and its layout stays as it is.
const NO_ICONS: ResourceIconsState = {
  workspaceId: null,
  sources: [],
  onImage: null,
};
let iconsState = NO_ICONS;
const iconListeners = new Set<() => void>();

function setIconsState(next: ResourceIconsState) {
  iconsState = next;
  for (const listener of iconListeners) listener();
}

function subscribeIcons(listener: () => void) {
  iconListeners.add(listener);
  return () => {
    iconListeners.delete(listener);
  };
}

/**
 * Registers the studio for "Use app icon": lists the resources whose icon
 * the server can fetch (App Store apps) once, and hands every icon used in
 * a picker, stored as a workspace image by the server, to `onImage`.
 */
export function useResourceIcons(
  workspaceId: string,
  onImage: (image: WorkspaceImage) => void,
): void {
  useEffect(() => {
    let active = true;
    setIconsState({ workspaceId, sources: [], onImage });
    listResourceIcons(workspaceId)
      .then(({ resources }) => {
        if (active) setIconsState({ ...iconsState, sources: resources });
      })
      .catch(() => {
        // No icons to offer; uploads still work.
      });
    return () => {
      active = false;
      setIconsState(NO_ICONS);
    };
  }, [workspaceId, onImage]);
}

async function storeIconOf(
  source: ResourceIconSource,
  locale: Locale,
): Promise<{ imageId: string } | { problem: string }> {
  const { workspaceId, onImage } = iconsState;
  if (!workspaceId) return { problem: "The studio is not open." };
  try {
    const { image } = await fetchResourceIcon(
      workspaceId,
      source.connectionId,
      source.resourceId,
    );
    onImage?.(image);
    return { imageId: image.id };
  } catch (cause) {
    return { problem: apiErrorMessage(cause, locale) };
  }
}

function sourceKey(source: ResourceIconSource): string {
  return `${source.connectionId}|${source.resourceId}`;
}

/** Picks an app and uses its icon; hidden when there is none to offer. */
function AppIconChooser({
  id,
  onChange,
  disabled,
}: {
  id: string;
  onChange: (imageId: string) => void;
  disabled: boolean;
}) {
  const locale = useLocale();
  const icons = useSyncExternalStore(
    subscribeIcons,
    () => iconsState,
    () => NO_ICONS,
  );
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (icons.sources.length === 0) return null;
  const several =
    new Set(icons.sources.map((source) => source.connectionId)).size > 1;
  const chosen = icons.sources.find((source) => sourceKey(source) === choice);
  return (
    <div className="image-picker-icon">
      <label htmlFor={`${id}-icon`} className="visually-hidden">
        App icon
      </label>
      <select
        id={`${id}-icon`}
        value={choice}
        disabled={disabled || busy}
        onChange={(event) => {
          setChoice(event.target.value);
          setProblem(null);
        }}
      >
        <option value="">App icon…</option>
        {icons.sources.map((source) => (
          <option key={sourceKey(source)} value={sourceKey(source)}>
            {source.name}
            {several ? ` (${source.connectionName})` : ""}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={!chosen || disabled || busy}
        onClick={() => {
          if (!chosen) return;
          setBusy(true);
          setProblem(null);
          void storeIconOf(chosen, locale)
            .then((result) => {
              if ("imageId" in result) onChange(result.imageId);
              else setProblem(result.problem);
            })
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Fetching…" : "Use app icon"}
      </button>
      {problem ? (
        <span className="error" role="alert">
          {problem}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Picks one of the workspace's images (logo, slide background, image
 * widget), with a preview, and uploads a new one in place when `onUpload`
 * is given. `onUpload` resolves to the new image's id, or null after an
 * error it reports itself.
 */
export function ImagePicker({
  id,
  label,
  noneLabel,
  images,
  value,
  onChange,
  onUpload,
}: {
  id: string;
  label: string;
  /** Offered as the empty choice; without it an image is required. */
  noneLabel?: string;
  images: PickableImage[];
  value: string | null;
  onChange: (imageId: string | null) => void;
  onUpload?: (file: File) => Promise<string | null>;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const current = images.find((image) => image.id === value) ?? null;

  const [dragging, setDragging] = useState(false);

  async function onFile(file: File | undefined) {
    if (!file || !onUpload) return;
    const local = uploadProblem(file);
    setProblem(local);
    if (local) return;
    setUploading(true);
    try {
      const uploaded = await onUpload(file);
      if (uploaded) {
        onChange(uploaded);
      }
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="field image-picker">
      <label htmlFor={id}>{label}</label>
      <div className="image-picker-row">
        {current ? (
          <img
            className="image-picker-preview"
            src={current.url}
            alt=""
            width={current.width}
            height={current.height}
          />
        ) : null}
        <select
          id={id}
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value || null)}
        >
          {noneLabel !== undefined || !current ? (
            <option value="">{noneLabel ?? "Choose an image"}</option>
          ) : null}
          {images.map((image) => (
            <option key={image.id} value={image.id}>
              {image.name || "Untitled image"} ({image.width} × {image.height})
            </option>
          ))}
        </select>
      </div>
      {onUpload ? (
        <AppIconChooser id={id} onChange={onChange} disabled={uploading} />
      ) : null}
      {onUpload ? (
        <div
          className={
            dragging
              ? "image-picker-upload image-picker-upload--drop"
              : "image-picker-upload"
          }
          onDragOver={(event: DragEvent<HTMLDivElement>) => {
            if (uploading) return;
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event: DragEvent<HTMLDivElement>) => {
            event.preventDefault();
            setDragging(false);
            if (!uploading) void onFile(event.dataTransfer.files[0]);
          }}
        >
          <label htmlFor={`${id}-file`}>
            Upload a new image, or drop one here{" "}
            <span className="help">(PNG, JPEG or WebP, at most 1 MiB)</span>
          </label>
          <input
            id={`${id}-file`}
            type="file"
            accept={IMAGE_CONTENT_TYPES.join(",")}
            disabled={uploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              void onFile(file);
            }}
          />
          {uploading ? (
            <p className="help" role="status">
              Uploading…
            </p>
          ) : null}
        </div>
      ) : null}
      {problem ? (
        <p className="error" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The workspace's images with a delete button for each one this draft
 * does not use. The server refuses images a saved dashboard still uses
 * (409 image_in_use, with their names), so a delete is always safe.
 */
export function ImageLibrary({
  images,
  inUse,
  onDelete,
}: {
  images: PickableImage[];
  /** Images the draft uses (logo, backgrounds, image widgets). */
  inUse: ReadonlySet<string>;
  /** Resolves to null when deleted, else why not. */
  onDelete: (imageId: string) => Promise<string | null>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (images.length === 0) return null;
  return (
    <details className="image-library">
      <summary>Workspace images ({images.length})</summary>
      <ul>
        {images.map((image) => {
          const used = inUse.has(image.id);
          const name = image.name || "Untitled image";
          return (
            <li key={image.id}>
              <img src={image.url} alt="" width={48} height={48} />
              <span>
                {name}
                <span className="help">
                  {" "}
                  {image.width} × {image.height}
                  {used ? " · used here" : ""}
                </span>
              </span>
              <button
                type="button"
                className="danger"
                disabled={used || busy !== null}
                title={used ? "Used by this dashboard" : undefined}
                aria-label={`Delete image ${name}`}
                onClick={() => {
                  if (!window.confirm(`Delete the image “${name}”?`)) return;
                  setBusy(image.id);
                  setProblem(null);
                  void onDelete(image.id)
                    .then(setProblem)
                    .finally(() => setBusy(null));
                }}
              >
                {busy === image.id ? "Deleting…" : "Delete"}
              </button>
            </li>
          );
        })}
      </ul>
      {problem ? (
        <p className="error" role="alert">
          {problem}
        </p>
      ) : null}
    </details>
  );
}
