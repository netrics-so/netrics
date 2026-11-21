import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ConfirmDialog,
  typedNameMatches,
  type Question,
} from "./confirm-dialog";

const question: Question = {
  title: "Delete dashboard “Sales”?",
  confirm: "Delete",
  cancel: "Cancel",
};

function render(value: Question) {
  return renderToStaticMarkup(
    <ConfirmDialog question={value} onConfirm={() => {}} onCancel={() => {}} />,
  );
}

// The app's own confirmation (#798), in place of window.confirm.
describe("ConfirmDialog", () => {
  it("is a dialog named by its title, with both answers", () => {
    const html = render(question);
    const titleId = /<h2 id="([^"]+)">Delete dashboard “Sales”\?<\/h2>/.exec(
      html,
    )?.[1];
    expect(titleId).toBeTruthy();
    expect(html).toMatch(
      new RegExp(`^<dialog[^>]*aria-labelledby="${titleId}"`),
    );
    expect(html).not.toContain("aria-describedby");
    expect(html).toContain('<button type="button" class="primary">Delete');
    expect(html).toContain('<button type="button">Cancel</button>');
    // No form of its own: it may be rendered inside one.
    expect(html).not.toContain("<form");
  });

  it("describes itself with the text when there is one", () => {
    const html = render({ ...question, text: "Its slides go with it." });
    const textId = /<p id="([^"]+)">Its slides go with it\.<\/p>/.exec(
      html,
    )?.[1];
    expect(textId).toBeTruthy();
    expect(html).toContain(`aria-describedby="${textId}"`);
  });

  it("marks a destructive answer as dangerous, not as the primary action", () => {
    const html = render({ ...question, destructive: true });
    expect(html).toContain('<button type="button" class="danger">Delete');
    expect(html).not.toContain('class="primary"');
  });

  it("keeps confirm disabled until the name is typed", () => {
    const html = render({
      ...question,
      destructive: true,
      typeToConfirm: { expected: "Acme", label: "Type “Acme” to confirm" },
    });
    const inputId = /<label for="([^"]+)">Type “Acme” to confirm<\/label>/.exec(
      html,
    )?.[1];
    expect(inputId).toBeTruthy();
    expect(html).toContain(`<input id="${inputId}" type="text"`);
    expect(html).toMatch(
      /<button type="button" class="danger" disabled="">Delete<\/button>/,
    );
    // Cancel stays available.
    expect(html).toContain('<button type="button">Cancel</button>');
  });
});

describe("typedNameMatches", () => {
  it.each([
    ["Acme", "Acme", true],
    ["  Acme ", "Acme", true],
    ["Acme", " Acme ", true],
    ["acme", "Acme", false],
    ["Acm", "Acme", false],
    ["Acme Inc", "Acme", false],
    ["", "Acme", false],
    // Nothing to type never confirms.
    ["", "", false],
    [" ", " ", false],
  ])("%j for %j is %s", (typed, expected, matches) => {
    expect(typedNameMatches(typed, expected)).toBe(matches);
  });
});
