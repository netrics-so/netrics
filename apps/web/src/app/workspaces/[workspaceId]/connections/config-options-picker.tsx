"use client";

import { useEffect, useId, useRef, useState } from "react";

import type { ConnectionConfigOptionsResponse } from "@netrics/contracts";

import { apiErrorMessage } from "@/lib/api";
import type { ConfigField } from "@/lib/config-schema";
import { useLocale, useT } from "@/lib/i18n/client";

/** A resource whose choices can be listed: discovery's ID and a name. */
export interface PickerResource {
  id: string;
  name: string;
}

/** Resources the picker lists before "show more". */
export const PICKER_RESOURCES_SHOWN = 50;

type Listing =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      options: ConnectionConfigOptionsResponse["options"];
      truncated: boolean;
    };

/** The chosen values, each with the resource it belongs to. */
export type Picked = ReadonlyMap<string, string>;

/** The field's value for `picked`: the values, separated by spaces. */
export function pickedValue(picked: Picked): string {
  return [...picked.keys()].join(" ");
}

/**
 * Toggles `value` (of `resourceId`) in `picked`; a new choice beyond
 * `max` is not added. Returns the same map when nothing changed.
 */
export function togglePicked(
  picked: Picked,
  value: string,
  resourceId: string,
  max: number,
): Picked {
  const next = new Map(picked);
  if (next.has(value)) next.delete(value);
  else if (next.size < max) next.set(value, resourceId);
  else return picked;
  return next;
}

interface ConfigOptionsPickerProps {
  field: ConfigField;
  /** How many choices may be made in all (`configOptions.maxSelected`). */
  maxSelected: number;
  /** The resources to choose in; null until they are listed. */
  resources: readonly PickerResource[] | null;
  /** Lists the resources (an existing connection's), when they are null. */
  loadResources?: () => Promise<PickerResource[]>;
  /** The field's current value, as stored or typed before. */
  value: string;
  onChange: (value: string) => void;
  /** Lists one resource's choices with the draft settings. */
  load: (resourceId: string) => Promise<ConnectionConfigOptionsResponse>;
  disabled?: boolean;
}

/**
 * A config field chosen from lists instead of typed (#891), such as
 * PostHog's saved insights: per resource, its choices are listed on
 * request (one listing each), with nothing chosen at first unless the
 * field already chooses it. At most `maxSelected` in all. Until a list is
 * loaded, the field keeps its value untouched, so a value saved in an
 * older form (pasted links) stays as it was.
 */
export function ConfigOptionsPicker({
  field,
  maxSelected,
  resources: givenResources,
  loadResources,
  value,
  onChange,
  load,
  disabled,
}: ConfigOptionsPickerProps) {
  const locale = useLocale();
  const t = useT("connections.configOptions");
  const config = useT("connections.config");
  const id = useId();
  const [loadedResources, setLoadedResources] = useState<
    PickerResource[] | null
  >(null);
  const [resourcesState, setResourcesState] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const resources = givenResources ?? loadedResources;
  const [picked, setPicked] = useState<Picked | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [listings, setListings] = useState<ReadonlyMap<string, Listing>>(
    new Map(),
  );
  const [shown, setShown] = useState(PICKER_RESOURCES_SHOWN);
  // The value the picker last wrote, so a value changed from outside (a
  // new draft) is not overwritten by an older choice.
  const written = useRef<string | null>(null);

  useEffect(() => {
    if (written.current !== null && value !== written.current) {
      setPicked(null);
      written.current = null;
    }
  }, [value]);

  function choose(next: Picked) {
    setPicked(next);
    const text = pickedValue(next);
    written.current = text;
    onChange(text);
  }

  async function list(resourceId: string) {
    setListings((current) =>
      new Map(current).set(resourceId, { status: "loading" }),
    );
    try {
      const result = await load(resourceId);
      setListings((current) =>
        new Map(current).set(resourceId, {
          status: "ready",
          options: result.options,
          truncated: result.truncated === true,
        }),
      );
      // The first listing reads what the field chooses now.
      setPicked(
        (current) =>
          current ??
          new Map(
            result.selected.map((entry) => [entry.value, entry.resourceId]),
          ),
      );
    } catch (cause) {
      setListings((current) =>
        new Map(current).set(resourceId, {
          status: "error",
          message: apiErrorMessage(cause, locale),
        }),
      );
    }
  }

  function toggleOpen(resourceId: string) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(resourceId)) next.delete(resourceId);
      else next.add(resourceId);
      return next;
    });
    const listing = listings.get(resourceId);
    if (!open.has(resourceId) && (!listing || listing.status === "error")) {
      void list(resourceId);
    }
  }

  // One resource: nothing to open first.
  const single = resources?.length === 1 ? resources[0]!.id : null;
  useEffect(() => {
    if (single !== null && !disabled) {
      setOpen(new Set([single]));
      void list(single);
    }
    // Listed once per single resource; `list` reads the latest draft.
  }, [single]);

  async function onLoadResources() {
    if (!loadResources) return;
    setResourcesState({ status: "loading" });
    try {
      setLoadedResources(await loadResources());
      setResourcesState({ status: "idle" });
    } catch (cause) {
      setResourcesState({
        status: "error",
        message: apiErrorMessage(cause, locale),
      });
    }
  }

  const count = picked?.size ?? null;
  const full = picked !== null && picked.size >= maxSelected;
  const label = field.required
    ? field.label
    : config("optionalLabel", { label: field.label });

  return (
    <fieldset
      className="stack"
      aria-describedby={`${id}-help`}
      data-testid={`config-options-${field.key}`}
    >
      <legend>{label}</legend>
      <p className="help" id={`${id}-help`}>
        {field.description ? `${field.description} ` : ""}
        {t("limit", { max: maxSelected })}
      </p>
      <p className="muted" aria-live="polite">
        {count === null
          ? value.trim() !== ""
            ? t("keepsCurrent")
            : t("noneChosen")
          : t("chosen", { count, max: maxSelected })}
      </p>
      {resources === null ? (
        loadResources ? (
          <div className="actions">
            <button
              type="button"
              disabled={disabled || resourcesState.status === "loading"}
              onClick={onLoadResources}
            >
              {resourcesState.status === "loading"
                ? t("loading")
                : t("loadResources")}
            </button>
            {resourcesState.status === "error" ? (
              <p className="field-error" role="alert">
                {resourcesState.message}
              </p>
            ) : null}
          </div>
        ) : null
      ) : resources.length === 0 ? (
        <p className="muted">{t("noResources")}</p>
      ) : (
        <ul className="stack">
          {resources.slice(0, shown).map((resource) => {
            const listing = listings.get(resource.id);
            const isOpen = open.has(resource.id);
            const listId = `${id}-${resource.id}`;
            const options = listing?.status === "ready" ? listing.options : [];
            const listed = new Set(options.map((option) => option.value));
            // Chosen values of this resource that its list does not offer
            // (a deleted report, one beyond the listed ones).
            const unlisted =
              listing?.status === "ready" && picked
                ? [...picked].filter(
                    ([chosen, owner]) =>
                      owner === resource.id && !listed.has(chosen),
                  )
                : [];
            return (
              <li key={resource.id} className="stack">
                <div className="actions">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-controls={listId}
                    disabled={disabled}
                    onClick={() => toggleOpen(resource.id)}
                  >
                    {isOpen
                      ? t("hide", { resource: resource.name })
                      : t("show", { resource: resource.name })}
                  </button>
                </div>
                {isOpen ? (
                  <div id={listId} className="stack">
                    {!listing || listing.status === "loading" ? (
                      <p className="muted" role="status">
                        {t("loading")}
                      </p>
                    ) : listing.status === "error" ? (
                      <div className="stack">
                        <p className="field-error" role="alert">
                          {listing.message}
                        </p>
                        <div className="actions">
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() => void list(resource.id)}
                          >
                            {t("retry")}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {options.length === 0 && unlisted.length === 0 ? (
                          <p className="muted">
                            {t("empty", { resource: resource.name })}
                          </p>
                        ) : (
                          <ul className="workspace-list">
                            {options.map((option) => {
                              const checked =
                                picked?.has(option.value) ?? false;
                              return (
                                <li key={option.value}>
                                  <label>
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      disabled={disabled || (!checked && full)}
                                      onChange={() =>
                                        picked &&
                                        choose(
                                          togglePicked(
                                            picked,
                                            option.value,
                                            resource.id,
                                            maxSelected,
                                          ),
                                        )
                                      }
                                    />{" "}
                                    {option.label}
                                    {option.description ? (
                                      <>
                                        {" "}
                                        <span className="muted">
                                          ({option.description})
                                        </span>
                                      </>
                                    ) : null}
                                  </label>
                                </li>
                              );
                            })}
                            {unlisted.map(([chosen]) => (
                              <li key={chosen}>
                                <label>
                                  <input
                                    type="checkbox"
                                    checked
                                    disabled={disabled}
                                    onChange={() =>
                                      picked &&
                                      choose(
                                        togglePicked(
                                          picked,
                                          chosen,
                                          resource.id,
                                          maxSelected,
                                        ),
                                      )
                                    }
                                  />{" "}
                                  {chosen}{" "}
                                  <span className="muted">{t("unlisted")}</span>
                                </label>
                              </li>
                            ))}
                          </ul>
                        )}
                        {listing.truncated ? (
                          <p className="muted">
                            {t("truncated", { count: options.length })}
                          </p>
                        ) : null}
                      </>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {resources && resources.length > shown ? (
        <div className="actions">
          <button
            type="button"
            onClick={() =>
              setShown((current) => current + PICKER_RESOURCES_SHOWN)
            }
          >
            {t("showMore", { count: resources.length - shown })}
          </button>
        </div>
      ) : null}
      {full ? <p className="muted">{t("full", { max: maxSelected })}</p> : null}
    </fieldset>
  );
}
