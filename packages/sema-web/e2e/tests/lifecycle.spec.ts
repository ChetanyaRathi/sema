/**
 * Lifecycle in a real browser: effects, deps, cleanup, on-unmount.
 *
 * The unit suite covers the slot bookkeeping. This covers the one thing it
 * structurally cannot: whether the real WASM VM survives an effect body that
 * calls a host function while nested inside a render that was itself invoked
 * from the host. The closely related shape — a host call inside a `map`
 * callback inside a mounted render — aborted the instance with
 * "RuntimeError: unreachable" until 2026-07-28 (docs/limitations.md 38, now
 * resolved), and jsdom plus a mock interpreter would report a clean pass either
 * way, which is exactly why this fixture exists.
 */
import { test, expect } from "@playwright/test";
import { waitForSema, captureBrowserFailures } from "../helpers";

test.beforeEach(async ({ page }) => {
  await page.goto("/lifecycle.html");
  await waitForSema(page);
});

const semaErrors = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as any).__semaErrors as string[]);

test("an effect body may call a host function without trapping the VM", async ({ page }) => {
  // The interval only exists if js/set-interval ran from inside the effect
  // body, so a rising tick count is the proof that the call went through.
  await expect(page.getByTestId("ticks")).not.toHaveText("0", { timeout: 5000 });
  expect(await semaErrors(page)).toEqual([]);
});

test("an empty deps list runs the body once, and its cleanup stops the timer", async ({ page }) => {
  await expect(page.getByTestId("ticks")).not.toHaveText("0", { timeout: 5000 });

  await page.getByTestId("unmount").click();
  await expect(page.getByTestId("clock")).toHaveCount(0);

  const stopped = await page.getByTestId("ticks").textContent();
  await page.waitForTimeout(400);
  await expect(page.getByTestId("ticks")).toHaveText(stopped!);
});

test("a keyed effect re-runs only when its dep changes", async ({ page }) => {
  await expect(page.getByTestId("runs")).toHaveText("1");
  await expect(page.getByTestId("cleanups")).toHaveText("0");

  // A re-render that changes nothing must not re-run the effect.
  await page.getByTestId("nudge").click();
  await page.getByTestId("nudge").click();
  await expect(page.getByTestId("runs")).toHaveText("1");
  await expect(page.getByTestId("cleanups")).toHaveText("0");

  // Changing the dep cleans up first, then runs again.
  await page.getByTestId("switch").click();
  await expect(page.getByTestId("clock-topic")).toHaveText("b");
  await expect(page.getByTestId("cleanups")).toHaveText("1");
  await expect(page.getByTestId("runs")).toHaveText("2");
});

test("cleanup runs exactly once per lifecycle, including at unmount", async ({ page }) => {
  await page.getByTestId("switch").click();
  await expect(page.getByTestId("cleanups")).toHaveText("1");

  await page.getByTestId("unmount").click();
  await expect(page.getByTestId("cleanups")).toHaveText("2");

  await page.waitForTimeout(300);
  await expect(page.getByTestId("cleanups")).toHaveText("2");
});

test("on-unmount fires once when the component is destroyed", async ({ page }) => {
  await expect(page.getByTestId("unmounted")).toHaveText("no");
  await page.getByTestId("unmount").click();
  await expect(page.getByTestId("unmounted")).toHaveText("yes");
});

test("nothing traps the WASM VM across the whole lifecycle", async ({ page }) => {
  const failures = captureBrowserFailures(page);
  await page.goto("/lifecycle.html");
  await waitForSema(page);

  await page.getByTestId("switch").click();
  await page.getByTestId("nudge").click();
  await page.getByTestId("switch").click();
  await page.getByTestId("unmount").click();
  await expect(page.getByTestId("unmounted")).toHaveText("yes");

  const all = [...failures.consoleErrors, ...failures.pageErrors].join("\n");
  expect(all).not.toContain("unreachable");
  expect(await semaErrors(page)).toEqual([]);
});
