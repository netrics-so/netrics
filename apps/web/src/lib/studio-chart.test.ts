import { describe, expect, it } from "vitest";

import { barLayout, lineChartGeometry } from "./studio-chart";

const format = (value: number) => String(Math.round(value));
const label = (bucket: string | undefined) =>
  bucket ? bucket.slice(5, 10) : null;

function points(values: Array<number | null>) {
  return values.map((value, index) => ({
    bucket: `2026-10-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    value,
  }));
}

describe("lineChartGeometry", () => {
  it("draws the current period, the previous one and labels its axes", () => {
    const geometry = lineChartGeometry({
      series: points([10, 20, 30, 40]),
      previous: points([5, 15, 25, 35]),
      width: 560,
      height: 200,
      showAxis: true,
      axisSize: 24,
      formatValue: format,
      bucketLabel: label,
    })!;
    expect(geometry.current).toHaveLength(1);
    expect(geometry.previous).toHaveLength(1);
    expect(geometry.area).toHaveLength(1);
    expect(geometry.yLabels.map((entry) => entry.text)).toEqual(["40", "0"]);
    expect(geometry.xLabels).toEqual([
      { x: geometry.plot.x, text: "10-01", anchor: "start" },
      {
        x: geometry.plot.x + geometry.plot.width,
        text: "10-04",
        anchor: "end",
      },
    ]);
    // The latest point is the top right corner of the plot.
    expect(geometry.last!.x).toBeCloseTo(geometry.plot.x + geometry.plot.width);
    expect(geometry.last!.y).toBeCloseTo(geometry.plot.y);
  });

  it("keeps axis labels at 24 units or more", () => {
    const geometry = lineChartGeometry({
      series: points([1, 2]),
      previous: null,
      width: 300,
      height: 150,
      showAxis: true,
      axisSize: 12,
      formatValue: format,
      bucketLabel: label,
    })!;
    expect(geometry.axisSize).toBe(24);
  });

  it("leaves gaps where there is no data, instead of bridging them", () => {
    const geometry = lineChartGeometry({
      series: points([1, 2, null, 4, 5]),
      previous: null,
      width: 300,
      height: 150,
      showAxis: false,
      formatValue: format,
      bucketLabel: label,
    })!;
    expect(geometry.current).toHaveLength(2);
    expect(geometry.previous).toEqual([]);
    expect(geometry.yLabels).toEqual([]);
    expect(geometry.xLabels).toEqual([]);
  });

  it("scales both periods on one axis that includes zero", () => {
    const geometry = lineChartGeometry({
      series: points([50, 60]),
      previous: points([100, 80]),
      width: 300,
      height: 150,
      showAxis: true,
      formatValue: format,
      bucketLabel: label,
    })!;
    expect(geometry.yLabels.map((entry) => entry.text)).toEqual(["100", "0"]);
    const negative = lineChartGeometry({
      series: points([-5, 10]),
      previous: null,
      width: 300,
      height: 150,
      showAxis: true,
      formatValue: format,
      bucketLabel: label,
    })!;
    expect(negative.yLabels.map((entry) => entry.text)).toEqual(["10", "-5"]);
  });

  it("draws nothing without at least two points of data", () => {
    const base = {
      previous: null,
      width: 300,
      height: 150,
      showAxis: true,
      formatValue: format,
      bucketLabel: label,
    };
    expect(lineChartGeometry({ ...base, series: points([4]) })).toBeNull();
    expect(
      lineChartGeometry({ ...base, series: points([null, null]) }),
    ).toBeNull();
  });
});

describe("barLayout", () => {
  const groups = [
    { label: "Wurfel", value: 812 },
    { label: "voilà", value: 604 },
    { label: "Paperstand – Magazine reader", value: 377 },
  ];

  it("lists the groups largest first, then Others, scaled to the largest", () => {
    const layout = barLayout({
      groups,
      others: { label: "Others", value: 129 },
      width: 560,
      height: 400,
      size: 30,
      formatValue: format,
    });
    expect(layout.rows.map((row) => row.label.text)).toEqual([
      "Wurfel",
      "voilà",
      "Paperstand – Magazine reader",
      "Others",
    ]);
    expect(layout.rows[0]!.ratio).toBe(1);
    expect(layout.rows[3]!.others).toBe(true);
    expect(layout.rows[3]!.ratio).toBeCloseTo(129 / 812);
    expect(layout.size).toBe(30);
    expect(layout.folded).toBe(0);
  });

  it("wraps a long label instead of cutting it", () => {
    const layout = barLayout({
      groups,
      others: null,
      width: 380,
      height: 400,
      size: 30,
      formatValue: format,
    });
    const long = layout.rows[2]!.label;
    expect(long.lines).toBe(2);
    expect(long.truncated).toBe(false);
  });

  it("shrinks labels to the minimum before folding bars into Others", () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      label: `App number ${index + 1}`,
      value: 100 - index,
    }));
    const roomy = barLayout({
      groups: many,
      others: null,
      width: 560,
      height: 560,
      size: 30,
      formatValue: format,
    });
    expect(roomy.folded).toBe(0);
    expect(roomy.size).toBeLessThanOrEqual(30);
    expect(roomy.size).toBeGreaterThanOrEqual(24);

    const tight = barLayout({
      groups: many,
      others: { label: "Others", value: 12 },
      width: 560,
      height: 200,
      size: 30,
      formatValue: format,
    });
    expect(tight.size).toBe(24);
    expect(tight.folded).toBeGreaterThan(0);
    const others = tight.rows[tight.rows.length - 1]!;
    expect(others.others).toBe(true);
    // Nothing disappears: the folded groups are part of Others.
    const shown = tight.rows.reduce((sum, row) => sum + row.value, 0);
    expect(shown).toBe(many.reduce((sum, row) => sum + row.value, 0) + 12);
  });

  it("truncates a label only when two lines at the minimum are not enough", () => {
    const layout = barLayout({
      groups: [
        { label: "Extremely long app name ".repeat(6).trim(), value: 1 },
      ],
      others: null,
      width: 300,
      height: 400,
      size: 30,
      formatValue: format,
    });
    expect(layout.size).toBe(24);
    expect(layout.rows[0]!.label.truncated).toBe(true);
  });
});
