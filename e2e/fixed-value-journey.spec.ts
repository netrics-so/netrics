import { expect, test } from "@playwright/test";
import { labels, type Locale } from "./support/labels.ts";
import { seedReferenceTable, startWorkspace } from "./support/session.ts";

const orders = {
  name: "Order counts",
  key: "order_counts",
  fields: [
    { id: "id", name: "ID", type: "string" as const, nullable: false },
    { id: "units", name: "Units", type: "integer" as const, nullable: true },
    {
      id: "revenue",
      name: "Revenue",
      type: "decimal" as const,
      nullable: false,
    },
  ],
  rows: [
    { id: "a", units: 3, revenue: "10.50" },
    { id: "b", units: null, revenue: "4.00" },
  ],
};

/**
 * A 0 typed as a calculation's fixed value reads as 0 in the formula view
 * (#630): next to a whole-number column, as the value for empty results,
 * and next to a decimal column, without a DECIMAL("0") wrapper.
 */
test("a typed 0 reads as 0 in the formula", async ({ page }, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const t = labels(locale);
  const b = t.builder;
  const exact = { exact: true } as const;

  const { workspaceId } = await startWorkspace(page, locale);
  await seedReferenceTable(page, workspaceId, orders);
  await page.goto(`/workspaces/${workspaceId}/data`);
  await page
    .getByRole("complementary")
    .getByRole("button", { name: orders.name })
    .click();
  await page.getByRole("button", { name: t.prepare }).click();
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(3);

  await page.getByRole("button", { name: t.addStep }).click();
  await page
    .getByRole("combobox", { name: t.operation })
    .selectOption({ label: t.calculate });
  await page.getByRole("textbox", { name: t.newName }).fill("Units plus");

  const first = page.getByRole("group", { name: b.value, ...exact });
  const second = page.getByRole("group", { name: b.secondValue });
  const formula = page.getByRole("combobox", { name: b.newValue });
  const formulaView = page.getByRole("radio", { name: t.formula });
  const visualView = page.getByRole("radio", { name: b.visual });
  const typeOf = (group: typeof first) =>
    group.getByRole("combobox", { name: t.type, ...exact });

  // [Units] plus a fixed 0: a whole number next to a whole-number column.
  await first
    .getByRole("combobox", { name: b.column, ...exact })
    .selectOption({ label: "Units" });
  await page
    .getByRole("combobox", { name: b.operation })
    .selectOption({ label: b.arithmetic.add });
  await second
    .getByRole("combobox", { name: b.source })
    .selectOption({ label: b.fixedValue });
  await second.getByRole("textbox", { name: b.fixedValue }).fill("0");
  await expect(typeOf(second)).toHaveValue("integer");
  await formulaView.check();
  await expect(formula).toHaveValue("ADD([Units], 0)");
  await visualView.check();
  await expect(second.getByRole("textbox", { name: b.fixedValue })).toHaveValue(
    "0",
  );

  // If empty, use 0.
  await page
    .getByRole("combobox", { name: b.result })
    .selectOption({ label: b.wrap.coalesce });
  const fallback = page.getByRole("group", { name: b.wrap.coalesce });
  await fallback
    .getByRole("combobox", { name: b.source })
    .selectOption({ label: b.fixedValue });
  await fallback.getByRole("textbox", { name: b.fixedValue }).fill("0");
  await formulaView.check();
  await expect(formula).toHaveValue("COALESCE(ADD([Units], 0), 0)");
  await visualView.check();

  // Next to a decimal column, 0 is a decimal and still reads as 0.
  await first
    .getByRole("combobox", { name: b.column, ...exact })
    .selectOption({ label: "Revenue" });
  await second
    .getByRole("combobox", { name: b.source })
    .selectOption({ label: b.column });
  await second
    .getByRole("combobox", { name: b.source })
    .selectOption({ label: b.fixedValue });
  await expect(typeOf(second)).toHaveValue("decimal");
  await second.getByRole("textbox", { name: b.fixedValue }).fill("0");
  await formulaView.check();
  await expect(formula).toHaveValue("COALESCE(ADD([Revenue], 0), 0)");
  await visualView.check();

  await page.getByRole("button", { name: t.applyStep }).click();
  await expect(
    page.getByRole("columnheader", { name: /^Units plus/ }),
  ).toBeVisible();
});
