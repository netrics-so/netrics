"use client";

import { useState, type ChangeEvent } from "react";

import { IMAGE_CONTENT_TYPES, IMAGE_MAX_BYTES } from "@netrics/contracts";

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

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
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
        <div className="image-picker-upload">
          <label htmlFor={`${id}-file`}>
            Upload a new image{" "}
            <span className="help">(PNG, JPEG or WebP, at most 1 MiB)</span>
          </label>
          <input
            id={`${id}-file`}
            type="file"
            accept={IMAGE_CONTENT_TYPES.join(",")}
            disabled={uploading}
            onChange={(event) => void onFile(event)}
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
