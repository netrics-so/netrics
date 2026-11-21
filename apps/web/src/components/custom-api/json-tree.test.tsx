import { describe, expect, it } from "vitest";

import {
  leafParts,
  initiallyExpanded,
  JsonTree,
  pickOf,
  treeItems,
  treeKey,
} from "./json-tree";
import { renderI18n } from "@/lib/i18n/test-render";

// The response tree of the builder (#807).

const BODY = {
  data: [
    { date: "2026-11-01", orders: 1, revenue: { amount: "12.50" } },
    { date: "2026-11-02", orders: 2, revenue: { amount: "13.00" } },
  ],
  meta: { next: "p2", deep: { deeper: { deepest: 1 } } },
};

const render = (props: Partial<Parameters<typeof JsonTree>[0]> = {}) =>
  renderI18n(
    <JsonTree
      value={BODY}
      recordPath={null}
      suggestedPath="data"
      fieldPaths={new Set()}
      mode="records"
      {...props}
    />,
  );

describe("JSON tree", () => {
  it("separates the server's string cut from the value", () => {
    expect(leafParts("abc… (5000 characters)")).toEqual({
      text: '"abc"',
      cut: "… (5000 characters)",
    });
    expect(leafParts("plain")).toEqual({ text: '"plain"', cut: null });
    expect(leafParts(12)).toEqual({ text: "12", cut: null });
  });

  it("picks the record array by click and by keyboard", () => {
    const html = render();
    // The suggested list is highlighted and has the button.
    expect(html).toMatch(
      /data-path="data" class="json-tree-item json-tree-item--array json-tree-item--picked"/,
    );
    expect(html).toContain('data-pick="data"');
    expect(html).toContain(">Use as records</button>");
    expect(html).not.toContain('data-pick="meta"');
    expect(html).toContain('role="tree"');
    const data = treeItems(BODY, initiallyExpanded(BODY)).find(
      (item) => item.path === "data",
    )!;
    // Space picks, Enter toggles, arrows move.
    expect(treeKey(" ", data)).toBe("pick");
    expect(pickOf(data, "records")).toBe("records");
    // Open with its first item only: Enter shows the rest (keyboard reach).
    expect(treeKey("Enter", data)).toBe("more");
    const all = treeItems(
      BODY,
      initiallyExpanded(BODY),
      new Set(["data"]),
    ).find((item) => item.path === "data")!;
    expect(treeKey("Enter", all)).toBe("toggle");
    expect(treeKey("ArrowDown", data)).toBe("next");
    expect(treeKey("ArrowLeft", data)).toBe("collapse");
    const meta = treeItems(BODY, initiallyExpanded(BODY)).find(
      (item) => item.path === "meta",
    )!;
    expect(pickOf(meta, "records")).toBeNull();
    const de = renderI18n(
      <JsonTree
        value={BODY}
        recordPath="data"
        fieldPaths={new Set()}
        mode="records"
      />,
      "de",
    );
    expect(de).toContain(">Als Einträge verwenden</button>");
  });

  it("ticks and unticks a field", () => {
    const record = BODY.data[0]!;
    const html = renderI18n(
      <JsonTree
        value={record}
        recordPath="data"
        fieldPaths={new Set(["orders"])}
        mode="fields"
      />,
    );
    expect(html).toContain('aria-label="orders" checked=""/>');
    expect(html).toContain('aria-label="date"/>');
    const leaf = treeItems(record, initiallyExpanded(record)).find(
      (item) => item.path === "revenue.amount",
    )!;
    expect(pickOf(leaf, "fields")).toBe("field");
    expect(treeKey(" ", leaf)).toBe("pick");
  });

  it("collapses deep levels", () => {
    const items = treeItems(BODY, initiallyExpanded(BODY));
    const paths = items.map((item) => item.path);
    // Root and first level open; the second level is listed, collapsed.
    expect(paths).toContain("meta.deep");
    expect(items.find((i) => i.path === "meta.deep")!.expanded).toBe(false);
    expect(paths).not.toContain("meta.deep.deeper");
    // Arrays show their first item only until all are asked for.
    expect(paths).toContain("data[0]");
    expect(paths).not.toContain("data[1]");
    expect(items.find((i) => i.path === "data")!.hiddenItems).toBe(1);
    const all = treeItems(BODY, initiallyExpanded(BODY), new Set(["data"]));
    expect(all.map((i) => i.path)).toContain("data[1]");
  });

  it("renders truncation markers", () => {
    const cut = {
      items: [{ a: 1 }, "… 48 more"],
      wide: { a: 1, "…": "120 more keys" },
      text: "abc… (5000 characters)",
    };
    const items = treeItems(
      cut,
      new Set(["", "items", "wide"]),
      new Set(["items"]),
    );
    expect(
      items.filter((i) => i.kind === "marker").map((i) => i.value),
    ).toEqual(["… 48 more", "… 120 more keys"]);
    const html = renderI18n(
      <JsonTree
        value={cut}
        recordPath={null}
        fieldPaths={new Set()}
        mode="records"
      />,
    );
    expect(html).toContain(
      '<span class="json-tree-marker">… 120 more keys</span>',
    );
    // A cut string shows its cut as a marker, not as data.
    expect(html).toContain(
      '&quot;abc&quot;<span class="json-tree-marker"> … (5000 characters)</span>',
    );
    // A list of objects with a marker is still a record list.
    expect(html).toContain('data-pick="items"');
  });
});
