/**
 * Event modifiers and form helpers in a real browser.
 *
 * The unit suite proves the encoding, the delegator, and the field flattening
 * separately against jsdom. What only a browser can prove is the chain: that a
 * dotted keyword survives the reader and the WASM map-key marshalling, that
 * `.prevent` stops a genuine navigation, and that the extracted field map
 * reads back with keyword keys — a marshalling bug there returns nil with no
 * error anywhere.
 */
import { test, expect } from "@playwright/test";
import { waitForSema } from "../helpers";

test.beforeEach(async ({ page }) => {
  await page.goto("/forms.html");
  await waitForSema(page);
});

test.describe(".prevent", () => {
  test("blocks a submission that really would navigate", async ({ page }) => {
    const before = page.url();

    await page.getByTestId("submit").click();

    await expect(page.getByTestId("title-field")).toHaveText("hello");
    expect(page.url()).toBe(before);
    await expect(page.getByTestId("form")).toBeVisible();
  });

  test("the same form without the modifier does navigate", async ({ page }) => {
    // The control. Without it, a `.prevent` that silently did nothing would
    // still pass the test above on any page that happens not to navigate.
    await page.getByTestId("plain-submit").click();

    await page.waitForURL(/navigated\.html/);
    await expect(page.locator("#navigated")).toHaveText("navigated");
  });
});

test.describe("dom/event-form-data", () => {
  test("reads a single field by keyword", async ({ page }) => {
    await page.getByTestId("submit").click();

    await expect(page.getByTestId("title-field")).toHaveText("hello");
  });

  test("returns a repeated field name as a list", async ({ page }) => {
    // The acceptance criterion, through real marshalling: the two `tag` inputs
    // arrive as a Sema list, which the handler joins with "|".
    await page.getByTestId("submit").click();

    await expect(page.getByTestId("tag-field")).toHaveText("a|b");
  });

  test("includes the submitting button's own value", async ({ page }) => {
    await page.getByTestId("submit").click();

    await expect(page.getByTestId("action-field")).toHaveText("save");
  });

  test("omits disabled controls", async ({ page }) => {
    await page.getByTestId("submit").click();

    await expect(page.getByTestId("skipped-field")).toHaveText("absent");
  });

  test("picks up an edited value, not the rendered one", async ({ page }) => {
    await page.getByTestId("title").fill("edited");

    await page.getByTestId("submit").click();

    await expect(page.getByTestId("title-field")).toHaveText("edited");
  });
});

test.describe(".stop", () => {
  test("a button inside a clickable row does not trigger the row", async ({ page }) => {
    await page.getByTestId("row-stop").first().click();

    await expect(page.getByTestId("stop-hits")).toHaveText("1");
    await expect(page.getByTestId("row-hits")).toHaveText("0");
  });

  test("clicking the row itself still triggers it", async ({ page }) => {
    await page.getByTestId("row-label").first().click();

    await expect(page.getByTestId("row-hits")).toHaveText("1");
    await expect(page.getByTestId("stop-hits")).toHaveText("0");
  });
});

test.describe(".once", () => {
  test("fires once across the re-renders its own clicks cause", async ({ page }) => {
    await page.getByTestId("once").click();
    await expect(page.getByTestId("once-count")).toHaveText("1");

    await page.getByTestId("once").click();
    await page.getByTestId("once").click();

    await expect(page.getByTestId("once-count")).toHaveText("1");
  });

  test(".prevent.once still prevents after the handler is spent", async ({ page }) => {
    // The failure that made the ordering worth changing: with `.once` gating
    // first, the second submit of a `.prevent.once` form left the page. jsdom
    // cannot see this — nothing there navigates.
    const before = page.url();

    await page.getByTestId("once-submit").click();
    await expect(page.getByTestId("once-submits")).toHaveText("1");

    await page.getByTestId("once-submit").click();
    await page.getByTestId("once-submit").click();

    await expect(page.getByTestId("once-submits")).toHaveText("1");
    expect(page.url()).toBe(before);
    await expect(page.getByTestId("once-form")).toBeVisible();
  });

  test("survives a re-render caused by an unrelated handler", async ({ page }) => {
    await page.getByTestId("once").click();
    await page.getByTestId("row-label").first().click();
    await expect(page.getByTestId("row-hits")).toHaveText("1");

    await page.getByTestId("once").click();

    await expect(page.getByTestId("once-count")).toHaveText("1");
  });
});

test.describe(".self", () => {
  test("a click on a child does not fire the handler", async ({ page }) => {
    await page.getByTestId("backdrop-inner").click();

    await expect(page.getByTestId("backdrop-hits")).toHaveText("0");
  });

  test("a click on the element itself does", async ({ page }) => {
    // Inside the backdrop's padding, so the click target is the backdrop and
    // not the button it wraps.
    await page.getByTestId("backdrop").click({ position: { x: 6, y: 6 } });

    await expect(page.getByTestId("backdrop-hits")).toHaveText("1");
  });
});

test.describe(".capture", () => {
  test("the ancestor handler runs before the descendant's", async ({ page }) => {
    await page.getByTestId("capture-inner").click();

    await expect(page.getByTestId("capture-log")).toHaveText("outer;inner;");
  });
});

test.describe("value helpers", () => {
  test("dom/event-checked reads a checkbox", async ({ page }) => {
    await page.getByTestId("box").check();
    await expect(page.getByTestId("checked-text")).toHaveText("on");

    await page.getByTestId("box").uncheck();
    await expect(page.getByTestId("checked-text")).toHaveText("off");
  });

  test("dom/event-selected-values reads a multi-select", async ({ page }) => {
    await page.getByTestId("sizes").selectOption(["s", "l"]);

    await expect(page.getByTestId("picked")).toHaveText("s,l");
  });
});

test.describe("runtime health", () => {
  test("no errors are reported for the whole interaction", async ({ page }) => {
    // A WASM trap surfaces here rather than as a failed assertion, so this
    // guards the whole fixture — including the map callback that renders
    // modified `on-*` attributes.
    await page.getByTestId("submit").click();
    await page.getByTestId("once").click();
    await page.getByTestId("row-stop").first().click();
    await page.getByTestId("capture-inner").click();
    await expect(page.getByTestId("capture-log")).toHaveText("outer;inner;");

    expect(await page.evaluate(() => (window as any).__semaErrors)).toEqual([]);
  });
});
