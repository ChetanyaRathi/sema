/**
 * What a re-render may and may not do to the element the user is working in.
 *
 * jsdom has a focus model, but not a real one: real Chrome is where a focused
 * `<select>`, a caret, and a delegated handler that outlives its own attribute
 * all behave for real. The unit suite (`tests/focus-preservation.test.ts`) pins
 * the same contract against the real morphdom; this is the browser half.
 */
import { test, expect } from "@playwright/test";
import { waitForSema } from "../helpers";

test.beforeEach(async ({ page }) => {
  await page.goto("/focus.html");
  await waitForSema(page);
});

test("input retains focus and value after unrelated state change", async ({ page }) => {
  const input = page.getByTestId("text-input");
  await input.click();
  await input.fill("hello");

  // A re-render driven by a different state atom, with no click to move focus.
  await page.evaluate(() => {
    (window as any).__semaWeb.eval("(update! counter (fn (n) (+ n 1)))");
  });

  await expect(page.getByTestId("counter-display")).toHaveText("1");
  // Focus is not moved, and the typed value is not replaced by the rendered one.
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("hello");
});

test("a focused input loses the attributes the new render dropped", async ({ page }) => {
  const input = page.getByTestId("armed-input");
  await input.click();
  await expect(input).toHaveAttribute("class", "armed");

  // The first keypress disarms the input, so render 2 declares a bare input.
  await input.press("a");
  await expect(page.getByTestId("keys-seen")).toHaveText("1");

  await expect(input).not.toHaveAttribute("class", /.*/);
  await expect(input).not.toHaveAttribute("required", /.*/);
  await expect(input).not.toHaveAttribute("aria-invalid", /.*/);
  await expect(input).toBeFocused();
});

test("a handler the new render removed stops firing", async ({ page }) => {
  // The damaging half: `data-sema-on-*` is what the delegator matches on, so a
  // stale one keeps calling a handler the current render does not declare.
  const input = page.getByTestId("armed-input");
  await input.click();

  await input.press("a");
  await expect(page.getByTestId("keys-seen")).toHaveText("1");
  await input.press("b");
  await input.press("c");

  await expect(page.getByTestId("keys-seen")).toHaveText("1");
  await expect(input).not.toHaveAttribute("data-sema-on-keydown", /.*/);
  expect(await page.evaluate(() => (window as any).__semaErrors)).toEqual([]);
});

test("a focused select still receives new options", async ({ page }) => {
  // The user about to pick from a dropdown is exactly the user who has it
  // focused, so this is the case that must not silently freeze.
  const select = page.getByTestId("sizes");
  await select.focus();
  await expect(select.locator("option")).toHaveCount(1);

  await select.press("x");

  await expect(select.locator("option")).toHaveCount(3);
  await expect(select).toBeFocused();
  expect(await page.evaluate(() => (window as any).__semaErrors)).toEqual([]);
});

test("a focused select keeps the option the user picked", async ({ page }) => {
  const select = page.getByTestId("sizes");
  await page.evaluate(() => {
    (window as any).__semaWeb.eval('(put! sizes (list "s" "m" "l"))');
  });
  await expect(select.locator("option")).toHaveCount(3);
  await select.selectOption("m");
  await select.focus();

  // A render that rewrites the option list must not reset the choice: the
  // user's pick sets the `selected` property, never the attribute morphdom
  // drives `selectedIndex` from.
  await select.press("x");

  await expect(select).toHaveValue("m");
});
