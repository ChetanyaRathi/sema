/**
 * Which `on-*` names reach a handler, and what happens to the ones that cannot.
 *
 * Two browser-only claims. A misspelled event name has no observable symptom at
 * all short of the thing it was supposed to guard — a `.prevent`ed form really
 * does navigate away — so the diagnostic is the whole fix and it has to be
 * proven against a page that can navigate. And `mouseenter` has no delegated
 * form: it is synthesized from `mouseover` plus `relatedTarget`, which takes a
 * real pointer crossing real geometry to exercise.
 */
import { test, expect } from "@playwright/test";
import { waitForSema } from "../helpers";

const errorsOf = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as any).__semaErrors as string[]);

test.beforeEach(async ({ page }) => {
  await page.goto("/events.html");
  await waitForSema(page);
});

test.describe("unroutable event names", () => {
  test("a typo in the event name is reported, with the correction", async ({ page }) => {
    const errors = await errorsOf(page);

    const typo = errors.filter((e) => e.includes('Unknown event "sumbit"'));
    expect(typo).toHaveLength(1);
    expect(typo[0]).toContain("sip-render:on-handler");
    expect(typo[0]).toContain('Did you mean "submit"?');
  });

  test("the misspelled handler is not installed", async ({ page }) => {
    // Refused rather than rendered dead: the attribute the delegator matches on
    // is never written, so nothing about the DOM suggests a working handler.
    const form = page.getByTestId("typo-form");

    await expect(form).not.toHaveAttribute("data-sema-on-sumbit", /.*/);
    await expect(form).not.toHaveAttribute("data-sema-mods-sumbit", /.*/);
  });

  test("and the form it was meant to guard really does navigate", async ({ page }) => {
    // Why the diagnostic matters: this is the entire user-visible symptom of a
    // one-character typo, and it is indistinguishable from a working app until
    // it happens.
    await page.getByTestId("typo-submit").click();

    await page.waitForURL(/navigated\.html/);
  });

  test("an event that cannot bubble names its delegable stand-in", async ({ page }) => {
    const errors = await errorsOf(page);

    const focus = errors.filter((e) => e.includes('Event "focus"'));
    expect(focus).toHaveLength(1);
    expect(focus[0]).toContain("does not bubble");
    expect(focus[0]).toContain('Use "focusin"');
  });
});

test.describe("nested mouseenter / mouseleave", () => {
  /** Park the pointer outside the card, then cross onto the button. */
  const enterButton = async (page: import("@playwright/test").Page) => {
    const card = (await page.getByTestId("card").boundingBox())!;
    const button = (await page.getByTestId("hover-btn").boundingBox())!;
    await page.mouse.move(card.x + card.width + 40, card.y + 5);
    await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2);
    return { card, button };
  };

  test("entering a nested button also enters its card, outermost first", async ({ page }) => {
    await enterButton(page);

    await expect(page.getByTestId("hover-log")).toHaveText("card-enter;btn-enter;");
  });

  test("leaving fires both, innermost first, so nothing is unbalanced", async ({ page }) => {
    // The damaging half of the old asymmetry: the card's `mouseleave` fired for
    // a `mouseenter` it never got, so a hover-opened menu got a close with no
    // open.
    const { card } = await enterButton(page);

    await page.mouse.move(card.x + card.width + 40, card.y + 5);

    await expect(page.getByTestId("hover-log")).toHaveText(
      "card-enter;btn-enter;btn-leave;card-leave;",
    );
  });
});

test.describe("delegation coverage", () => {
  test("an event outside the original hardcoded list dispatches", async ({ page }) => {
    // `mousedown` installed a dead attribute before; the whole delegated set is
    // now one list shared by the renderer and the delegator.
    await page.getByTestId("mousedown-btn").click();

    await expect(page.getByTestId("mousedown-count")).toHaveText("1");
  });
});
