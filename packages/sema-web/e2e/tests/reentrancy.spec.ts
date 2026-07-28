/**
 * Lifecycle re-entrancy in a real browser.
 *
 * Findings 10, 18 and 9 of `docs/bugs/2026-07-28-sema-web-adversarial-findings.md`,
 * plus finding 37's request that the force-render!-from-an-effect-body case
 * stop being a throwaway probe: it was the one scenario that produced a
 * `RuntimeError: unreachable` in Chrome after section 38 was fixed, and nothing
 * in the suite could re-run it.
 *
 * jsdom covers the bookkeeping (tests/component-reentrancy.test.ts). Only a
 * real browser can show that the JS stack survives, that no wasm trap escapes,
 * and that a released callback handle really is the one the wasm side dedupes.
 */
import { test, expect } from "@playwright/test";
import { waitForSema, captureBrowserFailures } from "../helpers";

test.beforeEach(async ({ page }) => {
  await page.goto("/reentrancy.html");
  await waitForSema(page);
});

const semaErrors = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as any).__semaErrors as string[]);

/**
 * Errors other than the one `boom` deliberately provokes on every render.
 *
 * `boom` shares the page with the other scenarios and reports its refused
 * `force-render!` each time it renders, so an assertion of "nothing went wrong
 * here" has to exclude it by name rather than expect an empty list.
 */
async function otherErrors(page: import("@playwright/test").Page): Promise<string[]> {
  return (await semaErrors(page)).filter((e) => !e.startsWith("force-render:boom"));
}

const renders = (page: import("@playwright/test").Page, component: string) =>
  page.evaluate((name) => (window as any).__semaRenders(name) as number, component);

test("force-render! from inside an effect body renders once and is reported", async ({ page }) => {
  await expect(page.getByTestId("boom")).toHaveText("0");

  expect(await renders(page, "boom")).toBe(1);
  const errors = await semaErrors(page);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("force-render:boom");
  expect(errors[0]).toContain("already rendering");
});

test("a state write costs exactly one render, not a recursion", async ({ page }) => {
  await page.getByTestId("bump").click();
  await expect(page.getByTestId("boom")).toHaveText("1");

  expect(await renders(page, "boom")).toBe(2);
});

test("no render survives the unmount of a component whose effect forced renders", async ({ page }) => {
  await page.getByTestId("bump").click();
  await expect(page.getByTestId("boom")).toHaveText("1");

  await page.getByTestId("unmount-app").click();
  await expect(page.getByTestId("boom")).toHaveCount(0);
  const afterUnmount = await renders(page, "boom");

  // A write the destroyed component would have re-rendered on.
  await page.getByTestId("bump").click();
  await expect(page.getByTestId("gen")).toHaveText("2");

  expect(await renders(page, "boom")).toBe(afterUnmount);
});

test("an effect body that unmounts its own component still runs its cleanup", async ({ page }) => {
  await page.getByTestId("mount-selfd").click();

  await expect(page.getByTestId("log")).toHaveText("d-cleanup");
  await expect(page.getByTestId("selfd")).toHaveCount(0);
  expect(await otherErrors(page)).toEqual([]);
});

test("two components sharing one named on-unmount both tear down", async ({ page }) => {
  await expect(page.getByTestId("leaf")).toHaveCount(2);

  await page.getByTestId("unmount-a").click();
  await expect(page.getByTestId("log")).toHaveText("down");

  await page.getByTestId("unmount-b").click();

  // Used to stay at one "down", with `Unknown callback handle: 1` reported for
  // the second component's teardown.
  await expect(page.getByTestId("log")).toHaveText("down;down");
  expect(await otherErrors(page)).toEqual([]);
});

test("nothing traps the WASM VM across the whole re-entrancy sequence", async ({ page }) => {
  const failures = captureBrowserFailures(page);
  await page.goto("/reentrancy.html");
  await waitForSema(page);

  await page.getByTestId("bump").click();
  await page.getByTestId("mount-selfd").click();
  await page.getByTestId("unmount-a").click();
  await page.getByTestId("unmount-app").click();
  await page.getByTestId("unmount-b").click();
  await page.getByTestId("bump").click();
  await expect(page.getByTestId("gen")).toHaveText("2");

  const all = [...failures.consoleErrors, ...failures.pageErrors].join("\n");
  expect(all).not.toContain("unreachable");
  expect(all).not.toContain("Maximum call stack size exceeded");
});
