"use client";

import { BACKGROUND_DIM, SLIDE_SECONDS, STUDIO_LIMITS } from "@netrics/domain";

import type { StudioAction, StudioSlide } from "@/lib/studio-document";
import { useLocale, useT } from "@/lib/i18n/client";
import { slideTitle } from "@/lib/studio-widgets";

import { ImagePicker, type PickableImage } from "./image-picker";

/**
 * The selected slide's settings in the inspector (design 3b): name,
 * duration, whether screens show it, background, and moving, duplicating
 * or deleting it. Shown when no widget is selected; deleting asks first
 * (`confirmDelete`, which Delete on a slide in the rail opens too).
 */
export function SlideSettings({
  slides,
  selectedSlideId,
  defaultSeconds,
  images,
  dispatch,
  onUploadImage,
  confirmDelete,
  onConfirmDelete,
}: {
  slides: StudioSlide[];
  selectedSlideId: string;
  defaultSeconds: number;
  images: PickableImage[];
  dispatch: (action: StudioAction) => void;
  onUploadImage?: (file: File) => Promise<string | null>;
  /** The slide waiting for the delete confirmation, or null. */
  confirmDelete: string | null;
  onConfirmDelete: (slideId: string | null) => void;
}) {
  const locale = useLocale();
  const t = useT("studio.rail");
  const common = useT("common");
  const selectedIndex = Math.max(
    0,
    slides.findIndex((slide) => slide.id === selectedSlideId),
  );
  const selected = slides[selectedIndex];
  if (!selected) {
    return null;
  }
  const move = (to: number) =>
    dispatch({ type: "moveSlide", slideId: selected.id, to });

  return (
    <section
      className="inspector-section rail-slide"
      aria-labelledby="inspector-slide"
    >
      <div className="inspector-head">
        <h2 id="inspector-slide">
          {t("slide", { number: selectedIndex + 1 })}
        </h2>
        <span className="inspector-head-meta">
          {t("slidePosition", {
            number: selectedIndex + 1,
            count: slides.length,
          })}
        </span>
      </div>
      <div className="field">
        <label htmlFor="slide-name">{t("name")}</label>
        <input
          id="slide-name"
          type="text"
          value={selected.name ?? ""}
          maxLength={STUDIO_LIMITS.slideNameLength}
          placeholder={t("slide", { number: selectedIndex + 1 })}
          onChange={(event) =>
            dispatch({
              type: "updateSlide",
              slideId: selected.id,
              patch: {
                name: event.target.value === "" ? null : event.target.value,
              },
            })
          }
        />
      </div>
      <div className="field">
        <label htmlFor="slide-duration">{t("duration")}</label>
        <input
          id="slide-duration"
          type="number"
          inputMode="numeric"
          min={SLIDE_SECONDS.min}
          max={SLIDE_SECONDS.max}
          value={selected.durationSeconds ?? ""}
          placeholder={t("durationDefault", { seconds: defaultSeconds })}
          onChange={(event) =>
            dispatch({
              type: "updateSlide",
              slideId: selected.id,
              patch: {
                durationSeconds:
                  event.target.value === ""
                    ? null
                    : Math.round(Number(event.target.value)),
              },
            })
          }
        />
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={selected.enabled}
          onChange={(event) =>
            dispatch({
              type: "updateSlide",
              slideId: selected.id,
              patch: { enabled: event.target.checked },
            })
          }
        />
        {t("showOnScreens")}
      </label>
      <ImagePicker
        id="slide-background"
        label={t("background")}
        noneLabel={t("noBackground")}
        images={images}
        value={selected.background?.imageId ?? null}
        onChange={(imageId) =>
          dispatch({
            type: "updateSlide",
            slideId: selected.id,
            patch: {
              background: imageId
                ? {
                    imageId,
                    dim: selected.background?.dim ?? BACKGROUND_DIM.default,
                  }
                : null,
            },
          })
        }
        onUpload={onUploadImage}
      />
      {selected.background ? (
        <div className="field">
          <label htmlFor="slide-dim">
            {t("dim", { percent: selected.background.dim })}
          </label>
          <input
            id="slide-dim"
            type="range"
            min={BACKGROUND_DIM.min}
            max={BACKGROUND_DIM.max}
            step={5}
            value={selected.background.dim}
            onChange={(event) =>
              dispatch({
                type: "updateSlide",
                slideId: selected.id,
                patch: {
                  background: {
                    imageId: selected.background!.imageId,
                    dim: Number(event.target.value),
                  },
                },
              })
            }
          />
        </div>
      ) : null}
      <div className="actions rail-actions">
        <button
          type="button"
          onClick={() => move(selectedIndex - 1)}
          disabled={selectedIndex === 0}
          aria-label={t("moveUp")}
          title={t("moveUp")}
        >
          ↑
        </button>
        <button
          type="button"
          onClick={() => move(selectedIndex + 1)}
          disabled={selectedIndex === slides.length - 1}
          aria-label={t("moveDown")}
          title={t("moveDown")}
        >
          ↓
        </button>
        <button
          type="button"
          onClick={() =>
            dispatch({ type: "duplicateSlide", slideId: selected.id })
          }
          disabled={slides.length >= STUDIO_LIMITS.slides}
        >
          {t("duplicate")}
        </button>
        <button
          type="button"
          className="danger"
          onClick={() => onConfirmDelete(selected.id)}
          disabled={slides.length <= 1}
          title={slides.length <= 1 ? t("keepOne") : undefined}
        >
          {common("delete")}
        </button>
      </div>
      {confirmDelete === selected.id ? (
        <div
          className="rail-confirm"
          role="alertdialog"
          aria-label={t("delete")}
        >
          <p>
            {t("deleteConfirm", {
              slide: slideTitle(selected, selectedIndex, locale),
              widgets: selected.widgets.length,
            })}
          </p>
          <div className="actions">
            <button
              type="button"
              className="danger"
              autoFocus
              onClick={() => {
                onConfirmDelete(null);
                dispatch({ type: "deleteSlide", slideId: selected.id });
              }}
            >
              {t("delete")}
            </button>
            <button type="button" onClick={() => onConfirmDelete(null)}>
              {common("cancel")}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
