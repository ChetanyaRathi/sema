/**
 * Routing in a real browser: hash navigation, query strings, links, the
 * fallback route, focus/scroll side effects, and cleanup across navigation.
 *
 * The unit suite drives the router through jsdom with a mock interpreter, so
 * the route it asserts on never crosses the WASM boundary and the anchors it
 * clicks are never patched by morphdom. Both are exactly where a routing bug
 * hides: a route map that Sema cannot read with `(:path r)`, a repeated query
 * key that arrives as something other than a list, an `aria-current` that a
 * re-render fails to move, or a click that reloads the whole page.
 */
import { test, expect, type Page } from "@playwright/test";
import { waitForSema, captureBrowserFailures } from "../helpers";

async function open(page: Page, hash = ""): Promise<void> {
  await page.goto(`/router.html${hash}`);
  await waitForSema(page);
}

const semaErrors = (page: Page) => page.evaluate(() => (window as any).__semaErrors as string[]);
const pageId = (page: Page) => page.evaluate(() => (window as any).__pageId as string);

test("renders the route named by the URL hash at load", async ({ page }) => {
  await open(page, "#/todos");

  await expect(page.getByTestId("view")).toHaveText("todos");
  await expect(page.getByTestId("route-path")).toHaveText("/todos");
  await expect(page.getByTestId("route-handler")).toHaveText("todo-list-page");
});

test("a link click navigates without reloading the page", async ({ page }) => {
  const failures = captureBrowserFailures(page);
  await open(page);
  const before = await pageId(page);

  await page.getByTestId("link-detail").click();

  await expect(page.getByTestId("view")).toHaveText("detail");
  expect(page.url()).toContain("#/todos/42?tab=open&tag=a&tag=b");
  // A reload would re-run the init module and mint a new id.
  expect(await pageId(page)).toBe(before);
  expect(await semaErrors(page)).toEqual([]);
  expect(failures.pageErrors).toEqual([]);
});

test("the query string reaches Sema as a map, with a repeated key as a list", async ({ page }) => {
  await open(page);

  await page.getByTestId("link-detail").click();

  await expect(page.getByTestId("todo-id")).toHaveText("42");
  await expect(page.getByTestId("todo-tab")).toHaveText("open");
  await expect(page.getByTestId("todo-tags")).toHaveText("a,b");
});

test("a route without a query reports an empty query, not a missing one", async ({ page }) => {
  await open(page);

  await page.getByTestId("link-detail-7").click();

  await expect(page.getByTestId("todo-id")).toHaveText("7");
  await expect(page.getByTestId("todo-tab")).toHaveText("none");
  await expect(page.getByTestId("todo-tags")).toHaveText("none");
});

test("an unknown path renders the not-found route", async ({ page }) => {
  await open(page);

  await page.getByTestId("link-missing").click();

  await expect(page.getByTestId("view")).toHaveText("missing");
  await expect(page.getByTestId("route-handler")).toHaveText("missing-page");
  await expect(page.getByTestId("missing-path")).toHaveText("/nowhere");
});

test("aria-current follows the active link across re-renders", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("link-home")).toHaveAttribute("aria-current", "page");

  await page.getByTestId("link-todos").click();

  await expect(page.getByTestId("link-todos")).toHaveAttribute("aria-current", "page");
  // morphdom has to remove the attribute from the link that is no longer
  // current, not just add it to the new one.
  await expect(page.getByTestId("link-home")).not.toHaveAttribute("aria-current", /.*/);
});

test("leaving a route runs its effect cleanup exactly once", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("enters")).toHaveText("1");
  await expect(page.getByTestId("cleanups")).toHaveText("0");

  await page.getByTestId("link-todos").click();
  await expect(page.getByTestId("enters")).toHaveText("2");
  await expect(page.getByTestId("cleanups")).toHaveText("1");

  await page.getByTestId("link-detail-7").click();
  await expect(page.getByTestId("enters")).toHaveText("3");
  await expect(page.getByTestId("cleanups")).toHaveText("2");
});

test("navigation moves focus to the configured landmark", async ({ page }) => {
  await open(page);

  await page.getByTestId("link-todos").click();

  await expect(page.getByTestId("view")).toHaveText("todos");
  const focused = await page.evaluate(() => document.activeElement?.id ?? "");
  expect(focused).toBe("main");
});

test("navigation scrolls back to the top", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.scrollTo(0, 400));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  // Landing at scrollY 0 is necessary but not sufficient evidence: this fixture
  // also focuses #main, and focusing an element scrolls it into view — so the
  // position alone stays 0 even with scroll-to-top removed entirely. Record the
  // calls to prove the router itself asked for the scroll.
  await page.evaluate(() => {
    const calls: unknown[][] = [];
    (window as any).__scrollCalls = calls;
    const original = window.scrollTo.bind(window);
    (window as any).scrollTo = (...args: unknown[]) => {
      calls.push(args);
      (original as (...a: unknown[]) => void)(...args);
    };
  });

  // dispatchEvent rather than click(): Playwright scrolls an element into view
  // before clicking it, which would reset the scroll position itself.
  await page.getByTestId("link-todos").dispatchEvent("click");

  await expect(page.getByTestId("view")).toHaveText("todos");
  expect(await page.evaluate(() => (window as any).__scrollCalls)).toEqual([[0, 0]]);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("router/push! from a handler navigates", async ({ page }) => {
  await open(page);

  await page.getByTestId("push").click();

  await expect(page.getByTestId("view")).toHaveText("detail");
  await expect(page.getByTestId("todo-id")).toHaveText("99");
  await expect(page.getByTestId("todo-tab")).toHaveText("done");
});

test("the browser back button restores the previous route", async ({ page }) => {
  await open(page);
  await page.getByTestId("link-todos").click();
  await expect(page.getByTestId("route-path")).toHaveText("/todos");

  await page.goBack();

  await expect(page.getByTestId("route-path")).toHaveText("/");
  await expect(page.getByTestId("view")).toHaveText("home");
});

test("an off-site link renders as inert markup that cannot navigate", async ({ page }) => {
  await open(page, "#/hostile");
  const offsite = page.getByTestId("link-offsite");

  await expect(offsite).toHaveJSProperty("tagName", "SPAN");
  await expect(offsite).not.toHaveAttribute("href", /.*/);
  await offsite.click();

  expect(page.url()).toContain("#/hostile");
  expect(await semaErrors(page)).toContain(
    'router:link: router/link: expected an internal path string, got "https://evil.example/pwned" (not an internal path)',
  );
});

test("a backslash path is refused like a protocol-relative one", async ({ page }) => {
  // Only a real browser can prove why this matters: the WHATWG URL parser
  // resolves href="/\evil.example" to http://evil.example/, so an anchor the
  // router accepted would send the status bar, a ctrl-click and a middle-click
  // off-origin even though the router never runs.
  await open(page, "#/hostile");
  const backslash = page.getByTestId("link-backslash");

  await expect(backslash).toHaveJSProperty("tagName", "SPAN");
  await expect(backslash).not.toHaveAttribute("href", /.*/);
  // The control: the same string in a plain anchor really does leave the origin.
  const resolved = await page.evaluate(() => {
    const a = document.createElement("a");
    a.setAttribute("href", "/\\evil.example");
    return a.href;
  });
  expect(resolved).toBe("http://evil.example/");

  await backslash.click();

  expect(page.url()).toContain("#/hostile");
  // The router reports the path through JSON.stringify, which escapes the
  // backslash a second time.
  expect(await semaErrors(page)).toContain(
    'router:link: router/link: expected an internal path string, got "/\\\\evil.example" (not an internal path)',
  );
});

test("a route with a non-ASCII literal segment is reachable", async ({ page }) => {
  // The browser rewrites what the router wrote: location.hash reads back
  // percent-encoded, so this route only resolves if the compiled pattern
  // matches the encoded form as well as the authored one.
  const failures = captureBrowserFailures(page);
  await open(page);

  await page.getByTestId("link-search").click();

  await expect(page.getByTestId("view")).toHaveText("search");
  expect(page.url()).toContain("#/s%C3%B8k");
  await expect(page.getByTestId("route-handler")).toHaveText("search-page");
  await expect(page.getByTestId("link-search")).toHaveAttribute("aria-current", "page");
  expect(await semaErrors(page)).toEqual([]);
  expect(failures.pageErrors).toEqual([]);
});

test("a non-ASCII route is reachable from a typed URL", async ({ page }) => {
  await open(page, "#/søk");

  await expect(page.getByTestId("view")).toHaveText("search");
  await expect(page.getByTestId("route-handler")).toHaveText("search-page");
});
