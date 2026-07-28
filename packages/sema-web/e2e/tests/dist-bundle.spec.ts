/**
 * The published artifact, in a real browser.
 *
 * Every other spec in this directory imports `../../../src/index.ts`, so the
 * whole browser suite exercises vite-transformed source and the built bundle's
 * only validation is that tsup exited 0. That gap is not theoretical: an
 * `exports` map with no reachable entry for half its consumers shipped exactly
 * because nothing crossed the package boundary.
 *
 * This fixture imports `@sema-lang/sema-web` **by name**, so the browser has to
 * resolve the manifest's `exports` map and load `dist/index.js`. Skipped when
 * `dist/` is absent — a browser run before `npm run build` should not report a
 * packaging failure.
 */
import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { waitForSema, captureBrowserFailures } from "../helpers";

const DIST_ENTRY = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

test.skip(!existsSync(DIST_ENTRY), "dist/ not built; run npm run build first");

test("the built bundle boots and runs a component through the exports map", async ({ page }) => {
  const failures = captureBrowserFailures(page);

  await page.goto("/dist-bundle.html");
  await waitForSema(page);

  // Resolved through `exports`, not through a relative path into src/.
  const entry = await page.evaluate(() =>
    [...document.querySelectorAll("script[type=module]")].map((s) => (s as HTMLScriptElement).src),
  );
  expect(entry.join(" ")).toContain("init-dist-bundle");

  await expect(page.getByTestId("count")).toHaveText("0");
  await page.getByTestId("inc").click();
  await expect(page.getByTestId("count")).toHaveText("1");

  // The router registered too: a bundle missing a whole namespace still boots.
  await expect(page.getByTestId("route")).toHaveText("home");
  await page.getByTestId("link-second").click();
  await expect(page.getByTestId("route")).toHaveText("second");

  expect(await page.evaluate(() => (window as any).__semaErrors)).toEqual([]);
  expect(failures.pageErrors).toEqual([]);
});
