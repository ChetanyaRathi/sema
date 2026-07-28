/**
 * Async resources in a real browser: real `fetch`, real WASM, real morphdom.
 *
 * `resource` is the one shipped primitive whose entire job is to touch the
 * network, and until this file it had no browser coverage at all — every test
 * ran against jsdom with `fetch` stubbed out. A green jsdom suite is not
 * evidence about the browser (the 2026-07-28 wave shipped a WASM trap past
 * 7291 green Rust tests), and it is especially not evidence about a feature
 * whose spec function is a Sema closure the host calls back into.
 *
 * Requests are intercepted with `page.route` rather than served from disk so
 * the test can assert on *which URLs actually left the page* — the only way to
 * tell "refetched with the new inputs" from "re-rendered the old response".
 */
import { test, expect, type Page } from "@playwright/test";
import { waitForSema, captureBrowserFailures } from "../helpers";

/** Bodies keyed by the `:id` segment the fixture builds its URL from. */
const USERS: Record<string, { status: number; contentType: string; body: string }> = {
  "1": { status: 200, contentType: "application/json", body: '{"name":"ada"}' },
  "2": { status: 200, contentType: "application/json", body: '{"name":"grace"}' },
  boom: { status: 500, contentType: "text/plain", body: "server on fire" },
  // A 200 whose body is not the JSON its content type promises: the decode
  // fails after the response arrived, which is the case that used to discard
  // the status it demonstrably had.
  garbage: { status: 200, contentType: "application/json", body: "not json at all" },
};

/**
 * Serve `/api/user/:id` from {@link USERS} and record every request that left
 * the page, in order.
 */
async function stubApi(page: Page): Promise<string[]> {
  const requested: string[] = [];
  await page.route("**/api/user/**", async (route) => {
    const url = new URL(route.request().url());
    requested.push(url.pathname);
    const id = url.pathname.split("/").pop() ?? "";
    const reply = USERS[id];
    if (!reply) {
      await route.fulfill({ status: 404, contentType: "text/plain", body: "no such user" });
      return;
    }
    await route.fulfill({
      status: reply.status,
      contentType: reply.contentType,
      body: reply.body,
    });
  });
  return requested;
}

const semaErrors = (page: Page) => page.evaluate(() => (window as any).__semaErrors as string[]);

/** Registry counts read straight out of the live runtime. */
const registries = (page: Page) =>
  page.evaluate(() => {
    const ctx = (window as any).__semaWeb.context;
    return {
      resources: ctx.resources.size,
      resourcesByKey: ctx.resourcesByKey.size,
      streams: ctx.streams.size,
    };
  });

test("loads on mount and renders value, status, and settled state", async ({ page }) => {
  const requested = await stubApi(page);
  await page.goto("/resource.html");
  await waitForSema(page);

  await expect(page.getByTestId("name")).toHaveText("ada");
  await expect(page.getByTestId("state")).toHaveText("settled");
  await expect(page.getByTestId("http-status")).toHaveText("200");
  await expect(page.getByTestId("error")).toHaveText("-");
  expect(requested).toEqual(["/api/user/1"]);
  expect(await semaErrors(page)).toEqual([]);
});

test("refetches when the state its URL is built from changes", async ({ page }) => {
  const requested = await stubApi(page);
  await page.goto("/resource.html");
  await waitForSema(page);
  await expect(page.getByTestId("name")).toHaveText("ada");

  await page.getByTestId("next").click();

  await expect(page.getByTestId("uid")).toHaveText("2");
  await expect(page.getByTestId("name")).toHaveText("grace");
  // The proof the new data was fetched rather than re-rendered from cache.
  expect(requested).toEqual(["/api/user/1", "/api/user/2"]);
  expect(await semaErrors(page)).toEqual([]);
});

test("a re-render that leaves the request alone does not refetch", async ({ page }) => {
  const requested = await stubApi(page);
  await page.goto("/resource.html");
  await waitForSema(page);
  await expect(page.getByTestId("name")).toHaveText("ada");

  // Back and forth: uid 1 -> 2 -> 1. The third render resolves the same
  // request the first one did, and re-checking the spec must not become a
  // request per render.
  await page.getByTestId("next").click();
  await expect(page.getByTestId("name")).toHaveText("grace");
  await page.getByTestId("next").click();
  await expect(page.getByTestId("name")).toHaveText("ada");

  expect(requested).toEqual(["/api/user/1", "/api/user/2", "/api/user/1"]);
});

test("refresh! from an event handler revalidates the same URL", async ({ page }) => {
  const requested = await stubApi(page);
  await page.goto("/resource.html");
  await waitForSema(page);
  await expect(page.getByTestId("name")).toHaveText("ada");

  await page.getByTestId("refresh").click();

  await expect(page.getByTestId("name")).toHaveText("ada");
  expect(requested).toEqual(["/api/user/1", "/api/user/1"]);
  expect(await semaErrors(page)).toEqual([]);
});

test("an error status keeps the previous value and reports once", async ({ page }) => {
  const failures = captureBrowserFailures(page);
  await stubApi(page);
  await page.goto("/resource.html");
  await waitForSema(page);
  await expect(page.getByTestId("name")).toHaveText("ada");

  await page.getByTestId("broken").click();

  await expect(page.getByTestId("error")).toContainText("HTTP 500");
  await expect(page.getByTestId("http-status")).toHaveText("500");
  // Revalidating never blanks the UI, even when it fails.
  await expect(page.getByTestId("name")).toHaveText("ada");
  const errors = await semaErrors(page);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("resource:user");
  expect(failures.pageErrors).toEqual([]);
});

test("a 200 whose body will not decode keeps its status", async ({ page }) => {
  await stubApi(page);
  await page.goto("/resource.html");
  await waitForSema(page);
  await expect(page.getByTestId("name")).toHaveText("ada");

  await page.getByTestId("garbage").click();

  await expect(page.getByTestId("error")).toContainText("JSON");
  // A component branching on `(:status @r)` has to be able to tell "the server
  // answered 200 with garbage" from "the transport never produced a response".
  await expect(page.getByTestId("http-status")).toHaveText("200");
});

test("unmounting the component drains every registry the resource owned", async ({ page }) => {
  const failures = captureBrowserFailures(page);
  const requested = await stubApi(page);
  await page.goto("/resource.html");
  await waitForSema(page);
  await expect(page.getByTestId("name")).toHaveText("ada");
  expect(await registries(page)).toEqual({ resources: 1, resourcesByKey: 1, streams: 1 });

  await page.getByTestId("unmount").click();
  await expect(page.getByTestId("card")).toHaveCount(0);

  expect(await registries(page)).toEqual({ resources: 0, resourcesByKey: 0, streams: 0 });
  // Nothing re-renders a destroyed component, so nothing re-checks its spec.
  expect(requested).toEqual(["/api/user/1"]);
  expect(await semaErrors(page)).toEqual([]);
  expect(failures.pageErrors).toEqual([]);
});
