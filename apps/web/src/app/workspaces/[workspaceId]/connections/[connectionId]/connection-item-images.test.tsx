import { describe, expect, it } from "vitest";

import type { ConnectionItemImages as StreamItemImages } from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import { ConnectionItemImages } from "./connection-item-images";
import { renderI18n } from "@/lib/i18n/test-render";

// A custom API connection's item images per stream (#809), in English and
// German.

const NOW = Date.parse("2026-11-20T12:10:00Z");

const stream = (
  overrides: Partial<StreamItemImages> = {},
): StreamItemImages => ({
  streamKey: "photos",
  streamName: "Photos",
  checkedAt: "2026-11-20T12:00:00Z",
  stored: 2,
  unchanged: 7,
  skipped: 0,
  skippedReasons: {},
  ...overrides,
});

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "\n")
    .replace(/&#x27;/g, "'")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

function render(locale: Locale, streams: StreamItemImages[]) {
  return renderI18n(
    <ConnectionItemImages streams={streams} now={NOW} />,
    locale,
  );
}

const broken = stream({
  stored: 0,
  unchanged: 0,
  skipped: 7,
  skippedReasons: {
    invalid_url: 1,
    host_not_allowed: 1,
    fetch_failed: 1,
    too_large: 1,
    unsupported_type: 1,
    invalid_image: 1,
    quota_exceeded: 1,
  },
});

describe("connection item images (#809)", () => {
  it("summarises the stored images per stream in English", () => {
    expect(text(render("en", [stream()]))).toEqual([
      "Images",
      "9 images stored for Photos · checked 10 minutes ago",
    ]);
    expect(text(render("en", [stream({ stored: 1, unchanged: 0 })]))).toContain(
      "1 image stored for Photos · checked 10 minutes ago",
    );
  });

  it("lists each skip reason in English", () => {
    expect(text(render("en", [broken]))).toEqual([
      "Images",
      "0 images stored for Photos · checked 10 minutes ago",
      "·",
      "7 images skipped",
      "1 × Not a valid https link",
      "1 × Host not in the definition's image hosts",
      "1 × Could not be downloaded",
      "1 × Larger than 2 MB",
      "1 × Not a PNG, JPEG or WebP image",
      "1 × Damaged, animated or too large in pixels",
      "1 × The workspace's image storage for custom APIs is full",
    ]);
  });

  it("speaks German", () => {
    expect(text(render("de", [stream({ stored: 1, unchanged: 0 })]))).toContain(
      "1 Bild für Photos gespeichert · geprüft vor 10 Minuten",
    );
    expect(text(render("de", [broken]))).toEqual([
      "Bilder",
      "0 Bilder für Photos gespeichert · geprüft vor 10 Minuten",
      "·",
      "7 Bilder übersprungen",
      "1 × Kein gültiger https-Link",
      "1 × Host steht nicht in den Bild-Hosts der Definition",
      "1 × Konnte nicht geladen werden",
      "1 × Größer als 2 MB",
      "1 × Kein PNG-, JPEG- oder WebP-Bild",
      "1 × Beschädigt, animiert oder zu viele Pixel",
      "1 × Der Bildspeicher deines Workspace für eigene APIs ist voll",
    ]);
  });

  it("renders nothing for an empty list", () => {
    expect(render("en", [])).toBe("");
  });
});
