import { describe, expect, it } from "vitest";

import { editConnectionRequest } from "./[connectionId]/edit-connection-form";
import {
  ConfigOptionsPicker,
  ownersUnsettled,
  pickedValue,
  rawChoices,
  reconcileOwners,
  togglePicked,
  withinResources,
} from "./config-options-picker";
import {
  coerceConfigValues,
  explicitEmptyKeys,
  parseConfigSchema,
  pickedEmptying,
} from "@/lib/config-schema";
import { renderI18n } from "@/lib/i18n/test-render";

// A config field chosen from lists per resource (#891), such as PostHog's
// saved insights: at most `maxSelected` in all, nothing chosen at first,
// and a stored value kept until a list is loaded. The lists themselves are
// driven in e2e/posthog-insight-picker-journey.spec.ts.

const [field] = parseConfigSchema({
  type: "object",
  properties: {
    insights: {
      type: "string",
      title: "Saved insights",
      description: "Saved trends insights.",
    },
  },
});

const noLoad = () => Promise.reject(new Error("not listed in this test"));

describe("config options picker (#891)", () => {
  it("toggles choices up to the limit, and writes them separated by spaces", () => {
    let picked = togglePicked(new Map(), "1000/a", "1000", 2);
    picked = togglePicked(picked, "1001/b", "1001", 2);
    expect(pickedValue(picked)).toBe("1000/a 1001/b");
    // A third is not added; the same map comes back.
    expect(togglePicked(picked, "1000/c", "1000", 2)).toBe(picked);
    // Clearing one makes room again.
    picked = togglePicked(picked, "1000/a", "1000", 2);
    expect(pickedValue(picked)).toBe("1001/b");
    expect(pickedValue(togglePicked(picked, "1000/c", "1000", 2))).toBe(
      "1001/b 1000/c",
    );
  });

  it.each(["en", "de"] as const)(
    "offers each resource's list, with nothing chosen (%s)",
    (locale) => {
      const html = renderI18n(
        <ConfigOptionsPicker
          field={field!}
          maxSelected={20}
          resources={[
            { id: "1000", name: "Site" },
            { id: "1001", name: "App" },
          ]}
          value=""
          onChange={() => {}}
          load={noLoad}
        />,
        locale,
      );
      expect(html).toContain("<legend>");
      expect(html).toContain(
        locale === "de" ? "In Site auswählen" : "Choose in Site",
      );
      expect(html).toContain(
        locale === "de" ? "In App auswählen" : "Choose in App",
      );
      expect(html).toContain(
        locale === "de" ? "Wähle höchstens 20." : "Choose at most 20.",
      );
      expect(html).toContain(
        locale === "de" ? "Nichts ist ausgewählt." : "Nothing is chosen.",
      );
      // No list is open, so no choice is offered yet.
      expect(html).not.toContain('type="checkbox"');
    },
  );

  it("keeps a stored value until a list is loaded, and lists resources on request", () => {
    const html = renderI18n(
      <ConfigOptionsPicker
        field={field!}
        maxSelected={20}
        resources={null}
        loadResources={() => Promise.resolve([])}
        value="https://us.posthog.com/project/1000/insights/AbCd1234"
        onChange={() => {}}
        load={noLoad}
      />,
    );
    expect(html).toContain(
      "The current choice stays as it is until you change it in a list below.",
    );
    expect(html).toContain("Show the lists");
    // Removable before any list is read, one by one or all (#891 review).
    expect(html).toContain(
      'aria-label="Remove https://us.posthog.com/project/1000/insights/AbCd1234"',
    );
    expect(html).toContain("Clear all");
  });

  it("reads typed choices, and drops those of resources left out (#891 review)", () => {
    expect(rawChoices(" a/1, b/2\nc/3 ")).toEqual(["a/1", "b/2", "c/3"]);
    expect(rawChoices("")).toEqual([]);
    const picked = new Map([
      ["1000/a", "1000"],
      ["1001/b", "1001"],
    ]);
    expect(withinResources(picked, new Set(["1000", "1001"]))).toBe(picked);
    expect([...withinResources(picked, new Set(["1000"]))]).toEqual([
      ["1000/a", "1000"],
    ]);
  });

  it("keeps a restored choice whose project is spelled anew until a listing names it (#937)", () => {
    // Chosen under project "01000" in an earlier check; the setup now
    // names the same project "1000".
    const restored = new Map([["1000/a", "01000"]]);
    const resources = new Set(["1000"]);
    // Not confirmed by a listing yet: kept, not dropped for its spelling.
    expect(withinResources(restored, resources, new Set(), false)).toBe(
      restored,
    );
    // A listing names its resource as the connector does now.
    const reconciled = reconcileOwners(restored, [
      { value: "1000/a", resourceId: "1000" },
      { value: "1001/b", resourceId: "1001" },
    ]);
    expect([...reconciled]).toEqual([["1000/a", "1000"]]);
    expect(withinResources(reconciled, resources, new Set(), true)).toBe(
      reconciled,
    );
    expect(reconcileOwners(reconciled, [])).toBe(reconciled);
    // A project the user unticked takes its choices, confirmed or not.
    const two = new Map([
      ["1000/a", "1000"],
      ["1001/b", "1001"],
    ]);
    expect([
      ...withinResources(two, new Set(["1000"]), new Set(["1001"]), false),
    ]).toEqual([["1000/a", "1000"]]);
  });

  it("waits for a listing when a restored choice's project is neither listed nor left out (#937 review)", () => {
    const restored = new Map([["1000/a", "1000"]]);
    // Project IDs changed to others: settled only by a listing.
    expect(
      ownersUnsettled(restored, new Set(["1001", "1002"]), new Set(), false),
    ).toBe(true);
    // Once confirmed, the choice goes with its project.
    expect(
      ownersUnsettled(restored, new Set(["1001", "1002"]), new Set(), true),
    ).toBe(false);
    expect([
      ...withinResources(restored, new Set(["1001", "1002"]), new Set(), true),
    ]).toEqual([]);
    // Listed, or unticked: nothing to wait for.
    expect(ownersUnsettled(restored, new Set(["1000"]), new Set(), false)).toBe(
      false,
    );
    expect(
      ownersUnsettled(restored, new Set(["1001"]), new Set(["1000"]), false),
    ).toBe(false);
    expect(ownersUnsettled(null, new Set(["1001"]), new Set(), false)).toBe(
      false,
    );
  });

  describe("emptying a field with a default (#937)", () => {
    const [explicit, keepOne, plain] = parseConfigSchema({
      type: "object",
      properties: {
        reports: { type: "string", title: "Reports", default: "r1/a" },
        views: {
          type: "string",
          title: "Views",
          default: "r1/a",
          minLength: 1,
        },
        insights: { type: "string", title: "Insights" },
      },
    });

    it("sends a cleared field empty when its schema allows it", () => {
      expect(pickedEmptying(explicit!)).toBe("explicit");
      expect(pickedEmptying(keepOne!)).toBe("keepOne");
      expect(pickedEmptying(plain!)).toBe("omit");
      const fields = [explicit!, keepOne!, plain!];
      const empty = explicitEmptyKeys(fields);
      expect([...empty]).toEqual(["reports"]);
      const values = { reports: "", views: "r1/a", insights: "" };
      // Left out, the default would be chosen again on save.
      expect(coerceConfigValues(fields, values, empty)).toEqual({
        reports: "",
        views: "r1/a",
      });
      expect(coerceConfigValues(fields, values)).toEqual({ views: "r1/a" });
    });

    it("saves an edited connection's cleared field empty", () => {
      const fields = [explicit!];
      const request = editConnectionRequest({
        connection: {
          name: "Reports",
          config: { reports: "r1/a" },
          customApi: null,
        } as unknown as Parameters<
          typeof editConnectionRequest
        >[0]["connection"],
        name: "Reports",
        fields,
        configValues: { reports: "" },
        token: "",
        fixedConfig: false,
        explicitEmpty: explicitEmptyKeys(fields),
      });
      expect(request).toEqual({ config: { reports: "" } });
    });

    it("keeps the last choice of a field that cannot be empty", () => {
      const html = renderI18n(
        <ConfigOptionsPicker
          field={keepOne!}
          maxSelected={20}
          resources={[{ id: "r1", name: "Site" }]}
          value="r1/a"
          onChange={() => {}}
          load={noLoad}
        />,
      );
      expect(html).toMatch(
        /<button type="button" disabled="" aria-label="Remove r1\/a"/,
      );
      expect(html).not.toContain("Clear all");
      expect(html).toContain("At least one must stay chosen.");
      // With two chosen, either can go.
      const two = renderI18n(
        <ConfigOptionsPicker
          field={keepOne!}
          maxSelected={20}
          resources={[{ id: "r1", name: "Site" }]}
          value="r1/a r1/b"
          onChange={() => {}}
          load={noLoad}
        />,
      );
      expect(two).toMatch(/<button type="button" aria-label="Remove r1\/a"/);
      // A field sent empty when cleared can be cleared.
      const clearable = renderI18n(
        <ConfigOptionsPicker
          field={explicit!}
          maxSelected={20}
          resources={[{ id: "r1", name: "Site" }]}
          value="r1/a"
          onChange={() => {}}
          load={noLoad}
        />,
      );
      expect(clearable).toContain("Clear all");
      expect(clearable).toMatch(
        /<button type="button" aria-label="Remove r1\/a"/,
      );
    });
  });
});
