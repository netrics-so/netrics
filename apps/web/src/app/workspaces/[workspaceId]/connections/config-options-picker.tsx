"use client";

import { useEffect, useId, useRef, useState } from "react";

import type { ConnectionConfigOptionsResponse } from "@netrics/contracts";

import { apiErrorMessage } from "@/lib/api";
import { pickedEmptying, type ConfigField } from "@/lib/config-schema";
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

/**
 * The values of a field not read by a listing yet, as typed or stored
 * (pasted links included): separated by spaces or commas.
 */
export function rawChoices(value: string): string[] {
  return value.split(/[\s,]+/).filter((token) => token !== "");
}

/**
 * `picked` without the choices of resources left out of the setup (#891
 * review): always those of `leftOut` (projects the user unticked), and
 * those of any other resource outside `resources` only once the owners are
 * `confirmed` by a listing. Owners restored from an earlier check may
 * spell a resource as it was named then (`01000`, now `1000`), and such a
 * choice is not dropped for its spelling (#937). The same map when none is
 * dropped.
 */
export function withinResources(
  picked: Picked,
  resources: ReadonlySet<string>,
  leftOut: ReadonlySet<string> = new Set(),
  confirmed = true,
): Picked {
  const next = new Map(
    [...picked].filter(
      ([, owner]) =>
        !leftOut.has(owner) && (!confirmed || resources.has(owner)),
    ),
  );
  return next.size === picked.size ? picked : next;
}

/**
 * Whether choices restored from an earlier check name a resource that is
 * neither listed nor left out (#937 review): a project spelled anew, or
 * one no longer named at all. Until a listing names their resources as
 * the connector does now, they cannot be kept or dropped.
 */
export function ownersUnsettled(
  picked: Picked | null,
  resources: ReadonlySet<string>,
  leftOut: ReadonlySet<string>,
  confirmed: boolean,
): boolean {
  if (confirmed || !picked) return false;
  for (const owner of picked.values()) {
    if (!resources.has(owner) && !leftOut.has(owner)) return true;
  }
  return false;
}

/**
 * `picked` with each choice's resource as a listing's `selected` names it
 * now (#937): the connector knows which resource a choice belongs to under
 * the current settings. Choices it does not name keep theirs, and none is
 * added or removed. The same map when nothing changed.
 */
export function reconcileOwners(
  picked: Picked,
  selected: ReadonlyArray<{ value: string; resourceId: string }>,
): Picked {
  let next: Map<string, string> | null = null;
  for (const entry of selected) {
    const owner = picked.get(entry.value);
    if (owner === undefined || owner === entry.resourceId) continue;
    next ??= new Map(picked);
    next.set(entry.value, entry.resourceId);
  }
  return next ?? picked;
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
  /**
   * Drops the choices of resources that leave `resources` (the setup,
   * where unticking a project leaves it out of the connection).
   */
  dropOutsideResources?: boolean;
  /**
   * With `dropOutsideResources`: the resources the user left out (unticked
   * projects), whose choices go even before a listing confirmed them.
   */
  leftOutResources?: readonly string[];
  /**
   * What the lists depend on besides the field (host, IDs, credentials):
   * when it changes, the listed resources and choices are listed afresh.
   */
  discoveryKey?: string;
  /**
   * Choices with their resources from an earlier picker of the same
   * field (the setup's previous check), used while they still spell the
   * field's value, so a resource unticked later still takes its choices.
   */
  initialPicked?: Picked | null;
  /** Hears every change of the choices and their resources. */
  onPickedChange?: (picked: Picked | null) => void;
  /**
   * Hears whether restored choices still wait for a listing to settle
   * their resources (#937 review): the setup creates nothing meanwhile.
   */
  onSettlingChange?: (settling: boolean) => void;
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
  dropOutsideResources = false,
  leftOutResources = [],
  discoveryKey = "",
  initialPicked = null,
  onPickedChange,
  onSettlingChange,
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
  const restored =
    initialPicked && pickedValue(initialPicked) === value
      ? initialPicked
      : null;
  const [picked, setPicked] = useState<Picked | null>(restored);
  // Whether the choices' resources are as the connector names them under
  // the current settings: not yet for choices restored from an earlier
  // check, until a listing reconciles them (#937).
  const [ownersConfirmed, setOwnersConfirmed] = useState(restored === null);
  // Read by requests when they answer: the value and choices then, and
  // the discovery revision they were sent under (#891 review).
  const valueNow = useRef(value);
  valueNow.current = value;
  const pickedNow = useRef(picked);
  pickedNow.current = picked;
  // The current loaders: a request sent again (below) lists with the
  // settings of now, not of the render that first sent it (#937).
  const loadNow = useRef(load);
  loadNow.current = load;
  const loadResourcesNow = useRef(loadResources);
  loadResourcesNow.current = loadResources;
  const revision = useRef(0);
  useEffect(() => {
    onPickedChange?.(picked);
    // Reports the choices only; the callback may change identity.
  }, [picked]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [listings, setListings] = useState<ReadonlyMap<string, Listing>>(
    new Map(),
  );
  const [shown, setShown] = useState(PICKER_RESOURCES_SHOWN);
  // Names of choices seen in a listing, for the list of chosen ones.
  const [labels, setLabels] = useState<ReadonlyMap<string, string>>(new Map());
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

  /**
   * Lists one resource. `settle`: listed to settle restored choices'
   * resources; if that fails, they count as settled, and those of
   * resources not listed go (fail closed, #937 review).
   */
  async function list(resourceId: string, settle = false): Promise<void> {
    const sent = revision.current;
    const sentValue = valueNow.current;
    setListings((current) =>
      new Map(current).set(resourceId, { status: "loading" }),
    );
    try {
      const result = await loadNow.current(resourceId);
      // Inputs changed since: this answer is for other settings.
      if (revision.current !== sent) return;
      // The field changed while the first list loaded (a choice removed
      // from its text): its `selected` is out of date, so list again
      // with the current value instead of undoing the change.
      if (pickedNow.current === null && valueNow.current !== sentValue) {
        return list(resourceId, settle);
      }
      setListings((current) =>
        new Map(current).set(resourceId, {
          status: "ready",
          options: result.options,
          truncated: result.truncated === true,
        }),
      );
      setLabels((current) => {
        const next = new Map(current);
        for (const option of result.options) {
          next.set(option.value, option.label);
        }
        return next;
      });
      // The first listing reads what the field chooses now; a later one
      // names the resources of the choices made (#937).
      setPicked((current) =>
        current
          ? reconcileOwners(current, result.selected)
          : new Map(
              result.selected.map((entry) => [entry.value, entry.resourceId]),
            ),
      );
      setOwnersConfirmed(true);
    } catch (cause) {
      if (revision.current !== sent) return;
      setListings((current) =>
        new Map(current).set(resourceId, {
          status: "error",
          message: apiErrorMessage(cause, locale),
        }),
      );
      if (settle) setOwnersConfirmed(true);
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

  // One resource: nothing to open first. A list already loaded or
  // loading for it is kept (#891 review).
  const single = resources?.length === 1 ? resources[0]!.id : null;
  useEffect(() => {
    if (single !== null && !disabled) {
      setOpen(new Set([single]));
      const listing = listings.get(single);
      if (!listing || listing.status === "error") void list(single);
    }
    // Listed once per single resource; `list` reads the latest draft.
  }, [single]);

  // New discovery inputs: the lists are read again on request (#891
  // review); the choices made stay.
  const discovered = useRef(discoveryKey);
  useEffect(() => {
    if (discovered.current === discoveryKey) return;
    discovered.current = discoveryKey;
    revision.current += 1;
    setOwnersConfirmed(false);
    setListings(new Map());
    setOpen(new Set());
    setLoadedResources(null);
    setResourcesState({ status: "idle" });
  }, [discoveryKey]);

  // A resource left out of the setup takes its choices with it.
  const resourceIds = resources?.map((resource) => resource.id).join("\n");
  const leftOutIds = leftOutResources.join("\n");
  useEffect(() => {
    if (!dropOutsideResources || !resources || !picked) return;
    const next = withinResources(
      picked,
      new Set(resources.map((resource) => resource.id)),
      new Set(leftOutResources),
      ownersConfirmed,
    );
    if (next !== picked) choose(next);
  }, [resourceIds, leftOutIds, picked, ownersConfirmed, dropOutsideResources]);

  // Restored choices of a resource neither listed nor left out (project
  // IDs changed since): one listing, of the first resource, names every
  // choice's resource as the connector does now; the effect above then
  // keeps or drops them. Even when no list is opened (#937 review).
  const settling =
    dropOutsideResources &&
    resources !== null &&
    resources.length > 0 &&
    ownersUnsettled(
      picked,
      new Set(resources.map((resource) => resource.id)),
      new Set(leftOutResources),
      ownersConfirmed,
    );
  useEffect(() => {
    onSettlingChange?.(settling);
    if (!settling || disabled) return;
    const first = resources![0]!.id;
    const listing = listings.get(first);
    if (listing?.status !== "loading") void list(first, true);
    // Started once per unsettled state; `list` reads the latest draft.
  }, [settling, disabled]);
  useEffect(() => () => onSettlingChange?.(false), []);

  async function onLoadResources() {
    const loader = loadResourcesNow.current;
    if (!loader) return;
    const sent = revision.current;
    setResourcesState({ status: "loading" });
    try {
      const loaded = await loader();
      if (revision.current !== sent) return;
      setLoadedResources(loaded);
      setResourcesState({ status: "idle" });
    } catch (cause) {
      if (revision.current !== sent) return;
      setResourcesState({
        status: "error",
        message: apiErrorMessage(cause, locale),
      });
    }
  }

  const count = picked?.size ?? null;
  const resourceNames = new Map(
    (resources ?? []).map((resource) => [resource.id, resource.name]),
  );
  // Every current choice, removable whatever its resource's list does
  // (not opened, refused, or the resource left out): the listed values,
  // or the field's own text before any list was read (#891 review).
  const chosen: Array<{ value: string; owner: string | null }> = picked
    ? [...picked].map(([chosenValue, owner]) => ({
        value: chosenValue,
        owner,
      }))
    : rawChoices(value).map((token) => ({ value: token, owner: null }));
  function remove(chosenValue: string) {
    if (picked) {
      const next = new Map(picked);
      next.delete(chosenValue);
      choose(next);
    } else {
      onChange(
        rawChoices(value)
          .filter((token) => token !== chosenValue)
          .join(" "),
      );
    }
  }
  const full = picked !== null && picked.size >= maxSelected;
  // A field whose schema refuses it empty, with a default that leaving it
  // out would choose again, keeps its last choice (#937).
  const keepsOne = pickedEmptying(field) === "keepOne";
  const lastOne = keepsOne && chosen.length <= 1;
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
      {chosen.length > 0 ? (
        <div className="stack">
          <ul className="workspace-list" aria-label={t("chosenList")}>
            {chosen.map((entry) => {
              const name = labels.get(entry.value) ?? entry.value;
              const where =
                entry.owner === null
                  ? null
                  : (resourceNames.get(entry.owner) ?? null);
              return (
                <li key={entry.value}>
                  {name}
                  {where ? (
                    <span className="muted"> ({where})</span>
                  ) : entry.owner !== null && resources ? (
                    <span className="muted"> {t("otherResource")}</span>
                  ) : null}{" "}
                  <button
                    type="button"
                    disabled={disabled || lastOne}
                    aria-label={t("remove", { choice: name })}
                    onClick={() => remove(entry.value)}
                  >
                    {t("removeShort")}
                  </button>
                </li>
              );
            })}
          </ul>
          {keepsOne ? (
            <p className="muted">{t("keepsOne")}</p>
          ) : (
            <div className="actions">
              <button
                type="button"
                disabled={disabled}
                onClick={() => choose(new Map())}
              >
                {t("clearAll")}
              </button>
            </div>
          )}
        </div>
      ) : null}
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
                                      disabled={
                                        disabled ||
                                        (!checked && full) ||
                                        (checked && lastOne)
                                      }
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
                                    disabled={disabled || lastOne}
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
