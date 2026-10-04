import { describe, expect, it } from "vitest";

import type { DashboardWidget, DeviceWidget } from "@netrics/contracts";

import { ScrollCountdownCard } from "@/components/scroll/scroll-widgets";
import { renderI18n } from "@/lib/i18n/test-render";
import {
  countdownTargetAt,
  countdownTargetLine,
  countdownView,
} from "@/lib/studio-countdown";
import { fitCheck } from "@/lib/studio-fit-check";
import { draftFormatWarnings } from "@/lib/studio-formats";
import { labelPreview } from "@/lib/studio-inspector";
import { defaultCountdownTarget, newWidget } from "@/lib/studio-new-widget";

import { CountdownWidgetView } from "./countdown-widget";
import { DeviceWidgetView } from "./device-widget";

// The countdown widget (ADR 0019 section 8, #337).

/** Every font size the markup sets, in units. */
function fontSizes(html: string): number[] {
  return [...html.matchAll(/font-size:calc\(var\(--u\) \* ([\d.]+)\)/g)].map(
    (match) => Number(match[1]),
  );
}

/** The markup's text without tags, entities decoded. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Wed 7 Oct 2026, 10:00 in Berlin.
const TARGET_AT = new Date("2026-10-07T08:00:00Z");

const props = {
  now: new Date("2026-10-04T17:55:00Z"),
  label: "Launch in",
  targetAt: TARGET_AT,
  timeZone: "Europe/Berlin",
  options: { showTarget: true, doneText: null },
  placement: { x: 0, y: 0, w: 3, h: 2 },
  showHeader: true,
  fontScale: 1,
};

describe("countdown widget", () => {
  it("shows the time left with unit letters and the target line", () => {
    const html = renderI18n(<CountdownWidgetView {...props} />);
    expect(text(html)).toBe("Launch in2d14h05mWed 7 Oct · 10:00");
    expect(html).toContain('aria-label="2 d 14 h 05 m"');
    // Every text at least 24 units; the numbers at least the value's 64.
    expect(Math.min(...fontSizes(html))).toBeGreaterThanOrEqual(24);
    expect(Math.max(...fontSizes(html))).toBeGreaterThanOrEqual(64);
  });

  it("writes German unit letters and dates", () => {
    const html = renderI18n(<CountdownWidgetView {...props} />, "de");
    expect(html).toContain('aria-label="2 T 14 Std 05 Min"');
    expect(text(html)).toContain("Mi., 7. Okt. · 10:00");
  });

  it("shows fewer groups as the target nears", () => {
    const at = (now: string) =>
      renderI18n(<CountdownWidgetView {...props} now={new Date(now)} />).match(
        /aria-label="([^"]+)"/,
      )![1];
    expect(at("2026-10-06T17:55:00Z")).toBe("14 h 05 m");
    expect(at("2026-10-07T07:19:00Z")).toBe("41 m");
    expect(at("2026-10-07T07:59:30Z")).toBe("&lt; 1 m");
  });

  it("switches to the text when reached at 10:00 in Berlin", () => {
    const before = renderI18n(
      <CountdownWidgetView {...props} now={new Date("2026-10-07T07:59:00Z")} />,
    );
    expect(before).toContain('aria-label="1 m"');
    const at = renderI18n(
      <CountdownWidgetView {...props} now={new Date("2026-10-07T08:00:00Z")} />,
    );
    expect(text(at)).toBe("Launch inNowWed 7 Oct · 10:00");
    expect(at).toContain("sw-countdown-done");
    // At heading size (56) in the accent colour (the class's).
    expect(fontSizes(at)).toContain(56);
    const german = renderI18n(
      <CountdownWidgetView
        {...props}
        now={new Date("2026-10-08T00:00:00Z")}
        options={{ showTarget: false, doneText: null }}
      />,
      "de",
    );
    expect(text(german)).toBe("Launch inJetzt");
    const own = renderI18n(
      <CountdownWidgetView
        {...props}
        now={new Date("2026-10-08T00:00:00Z")}
        options={{ showTarget: false, doneText: "We are live" }}
      />,
    );
    expect(text(own)).toBe("Launch inWe are live");
  });

  it("renders a payload's countdown with its resolved target", () => {
    const widget: DeviceWidget = {
      type: "countdown",
      id: "00000000-0000-4000-8000-000000000001",
      x: 0,
      y: 0,
      w: 3,
      h: 2,
      label: "Countdown",
      options: {
        target: "2099-10-07T10:00",
        timeZone: "Europe/Berlin",
        showTarget: true,
        doneText: null,
        targetAt: "2099-10-07T08:00:00.000Z",
      },
    };
    const html = renderI18n(
      <DeviceWidgetView
        widget={widget}
        env={{
          timeZone: "UTC",
          showHeader: true,
          fontScale: 1,
          images: new Map(),
        }}
      />,
    );
    expect(text(html)).toContain("Countdown");
    expect(text(html)).toContain("Wed 7 Oct 2099 · 10:00");
  });

  it("shows a compact card in scroll view", () => {
    const html = renderI18n(
      <ScrollCountdownCard
        now={props.now}
        label="Launch in"
        options={{
          target: "2026-10-07T10:00",
          timeZone: "Europe/Berlin",
          showTarget: true,
          doneText: null,
        }}
        width={358}
        rootPx={16}
      />,
    );
    expect(html).toContain('aria-label="2 d 14 h 05 m"');
    expect(text(html)).toContain("Wed 7 Oct · 10:00");
    expect(Math.min(...fontSizes(html))).toBeGreaterThanOrEqual(24);
  });
});

describe("countdown text", () => {
  it("adds the year to a target in another year", () => {
    expect(
      countdownTargetLine(
        new Date("2027-10-07T08:00:00Z"),
        "Europe/Berlin",
        "en",
        props.now,
      ),
    ).toBe("Thu 7 Oct 2027 · 10:00");
  });

  it("prefers the payload's instant and resolves the options otherwise", () => {
    expect(
      countdownTargetAt({
        targetAt: "2026-10-07T08:00:00.000Z",
        target: "2026-10-07T12:00",
        timeZone: "UTC",
      })?.toISOString(),
    ).toBe("2026-10-07T08:00:00.000Z");
    expect(
      countdownTargetAt({
        target: "2026-10-07T10:00",
        timeZone: "America/New_York",
      })?.toISOString(),
    ).toBe("2026-10-07T14:00:00.000Z");
  });

  it("keeps the numbers the same size from minute to minute", () => {
    const view = (now: string) =>
      countdownView({
        ...props,
        now: new Date(now),
        locale: "en",
      }).layout.sizes.value;
    expect(view("2026-10-04T17:55:00Z")).toBe(view("2026-10-04T18:11:00Z"));
  });
});

describe("countdown in the Studio", () => {
  const countdown = (target: string, w = 3, h = 2): DashboardWidget => ({
    type: "countdown",
    id: "00000000-0000-4000-8000-000000000002",
    x: 0,
    y: 0,
    w,
    h,
    title: null,
    options: { target, timeZone: null, showTarget: true, doneText: null },
  });

  it("is added at its minimum with a target a week ahead", () => {
    const made = newWidget("countdown", {
      metrics: [],
      imageIds: [],
      locale: "en",
      now: new Date(2026, 9, 4, 18, 30),
    });
    expect(made).toEqual({
      widget: {
        type: "countdown",
        title: null,
        options: {
          target: "2026-10-11T10:00",
          timeZone: null,
          showTarget: true,
          doneText: null,
        },
      },
    });
    expect(defaultCountdownTarget(new Date(2026, 11, 28, 9))).toBe(
      "2027-01-04T10:00",
    );
  });

  it("labels it Countdown without a title", () => {
    expect(
      labelPreview(countdown("2026-10-07T10:00"), undefined, "de"),
    ).toMatchObject({
      label: "Countdown",
      defaultLabel: "Countdown",
      warning: null,
    });
  });

  it("says in the fit check when the target has passed or the line is left out", () => {
    const check = (widget: DashboardWidget, fontScale = 1) =>
      fitCheck({
        widget,
        label: "Countdown",
        unreadable: undefined,
        fontScale,
        showHeader: true,
        locale: "en",
        timeZone: "Europe/Berlin",
        now: new Date("2026-10-07T08:00:00Z"),
      });
    expect(check(countdown("2026-10-07T10:00"))?.state).toBe("partial");
    expect(check(countdown("2026-10-07T10:00"))?.text).toMatch(
      /^The target has passed/,
    );
    expect(check(countdown("2026-10-07T10:01"))).toEqual({
      state: "fits",
      text: "Label fits at 1080p",
    });
    expect(check(countdown("2026-10-07T10:01"), 1.3)?.text).toMatch(
      /target line does not fit/,
    );
  });

  it("warns countdown_passed (info) in the draft, and a past one still saves", () => {
    const context = {
      primaryFormat: "16x9" as const,
      fontScale: 1,
      showHeader: true,
      dashboardName: "Launch",
      logoAspect: null,
      timeZone: "Europe/Berlin",
      locale: "en" as const,
      now: new Date("2026-10-07T08:00:00Z"),
      labelOf: () => null,
    };
    const slide = (target: string) => ({
      id: "s",
      name: null,
      widgets: [countdown(target)],
    });
    expect(
      draftFormatWarnings(slide("2026-10-07T10:00"), context).map((warning) => [
        warning.format,
        warning.code,
        warning.severity,
      ]),
    ).toEqual([["16x9", "countdown_passed", "info"]]);
    expect(draftFormatWarnings(slide("2026-10-07T10:01"), context)).toEqual([]);
  });
});
