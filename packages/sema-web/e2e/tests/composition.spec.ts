/**
 * Composition in a real browser: props, children, keyed lists.
 *
 * The unit suite proves each mechanism in isolation against jsdom and a mock
 * interpreter. This drives the whole stack — real WASM, real morphdom, real
 * events — through `composition.sema`, because the failures these features
 * have are integration failures: a prop that marshals wrong reads as nil with
 * no error, and a key that is not wired through reaches the DOM as a
 * lost-focus bug and nothing else.
 */
import { test, expect } from "@playwright/test";
import { waitForSema } from "../helpers";

test.beforeEach(async ({ page }) => {
  await page.goto("/composition.html");
  await waitForSema(page);
});

test.describe("props", () => {
  test("mount-time props reach the root component", async ({ page }) => {
    await expect(page.getByTestId("heading")).toHaveText("Composition");
  });

  test("props are usable as attribute values, not just text", async ({ page }) => {
    await expect(page.getByTestId("root")).toHaveClass("light");
  });

  test("props thread down to a grandchild", async ({ page }) => {
    // app-root -> row (props) -> badge (props derived from row's props).
    // A marshalling bug anywhere on that path shows up as empty badges.
    await expect(page.getByTestId("badge").first()).toHaveText("T1");
    await expect(page.getByTestId("badge").nth(2)).toHaveText("T3");
  });
});

test.describe("children", () => {
  test("a layout component renders the children it was given", async ({ page }) => {
    await expect(page.getByTestId("child-a")).toHaveText("first child");
    await expect(page.getByTestId("child-b")).toHaveText("second child");
  });

  test("children land inside the layout's slot, not beside it", async ({ page }) => {
    // Position matters: rendering children as siblings of the panel rather
    // than inside its body would still show the text and still pass a naive
    // text assertion.
    const inBody = page.getByTestId("panel-body").getByTestId("child-a");
    await expect(inBody).toHaveCount(1);
  });

  test("children are passed per-instance, not shared", async ({ page }) => {
    // Every row gets its own slot child.
    await expect(page.getByTestId("row-slot")).toHaveCount(3);
  });
});

test.describe("error isolation", () => {
  test("a healthy child renders normally", async ({ page }) => {
    await expect(page.getByTestId("unstable-ok")).toHaveText("stable");
  });

  test("a throwing child does not take out its siblings", async ({ page }) => {
    await page.getByTestId("toggle-explode").click();

    await expect(page.getByTestId("unstable-ok")).toHaveCount(0);
    // The surrounding subtree renders normally — only the failing child is gone.
    await expect(page.getByTestId("before-unstable")).toHaveText("before");
    await expect(page.getByTestId("after-unstable")).toHaveText("after");
    await expect(page.getByTestId("heading")).toHaveText("Composition");
    await expect(page.getByTestId("row")).toHaveCount(3);
  });

  test("the failure is reported under the CHILD's name, not the parent's", async ({ page }) => {
    await page.getByTestId("toggle-explode").click();

    const errors = await page.evaluate(() =>
      (window as any).__semaDiagnostics().filter((e: any) => e.kind === "error"),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[errors.length - 1].context).toBe("component:unstable");
    expect(errors[errors.length - 1].detail).toContain("unstable child exploded");
  });

  test("the app keeps working after a child failure", async ({ page }) => {
    await page.getByTestId("toggle-explode").click();

    await page.getByTestId("add").click();
    await expect(page.getByTestId("row")).toHaveCount(4);
  });

  test("the app recovers when the child stops throwing", async ({ page }) => {
    await page.getByTestId("toggle-explode").click();
    await page.getByTestId("toggle-explode").click();

    await expect(page.getByTestId("unstable-ok")).toHaveText("stable");
  });
});

test.describe("keyed lists", () => {
  const rowIds = (page: import("@playwright/test").Page) =>
    page.locator("[data-row-id]").evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-row-id")),
    );

  test("renders one row per item", async ({ page }) => {
    await expect(page.getByTestId("row")).toHaveCount(3);
    expect(await rowIds(page)).toEqual(["1", "2", "3"]);
  });

  test("reversing reorders the rows", async ({ page }) => {
    await page.getByTestId("shuffle").click();
    expect(await rowIds(page)).toEqual(["3", "2", "1"]);
  });

  test("a focused, half-typed input survives a reorder", async ({ page }) => {
    // The headline reason keys exist. Without `getNodeKey`, morphdom matches
    // by position and this value lands on a different row.
    const input = page.locator('[data-row-input="2"]');
    await input.click();
    await input.fill("half typed");
    await expect(input).toBeFocused();

    // Trigger the reorder WITHOUT clicking: clicking a button necessarily
    // blurs the input, and the focus guard keys off document.activeElement.
    // Losing focus to a button you clicked is correct browser behaviour, not
    // the bug this test is about.
    await page.evaluate(() => {
      (window as any).__semaWeb.eval("(put! rows (reverse @rows))");
    });
    await page.waitForTimeout(100);

    const moved = page.locator('[data-row-input="2"]');
    await expect(moved).toHaveValue("half typed");
    await expect(moved).toBeFocused();
    expect(await rowIds(page)).toEqual(["3", "2", "1"]);
  });

  test("the moved row keeps the very same DOM node", async ({ page }) => {
    await page.evaluate(() => {
      const el = document.querySelector('[data-row-id="2"]');
      (el as any).__identityProbe = "same-node";
    });

    await page.getByTestId("shuffle").click();

    const probe = await page.evaluate(
      () => (document.querySelector('[data-row-id="2"]') as any)?.__identityProbe,
    );
    // An expando survives only if the node itself was moved, never if it was
    // rebuilt — the strongest available identity assertion.
    expect(probe).toBe("same-node");
  });

  test("removing a row leaves the others' nodes intact", async ({ page }) => {
    await page.evaluate(() => {
      (document.querySelector('[data-row-id="3"]') as any).__identityProbe = "kept";
    });

    await page.locator('[data-row-remove="2"]').click();

    expect(await rowIds(page)).toEqual(["1", "3"]);
    const probe = await page.evaluate(
      () => (document.querySelector('[data-row-id="3"]') as any)?.__identityProbe,
    );
    expect(probe).toBe("kept");
  });

  test("adding a row does not rebuild the existing ones", async ({ page }) => {
    await page.evaluate(() => {
      (document.querySelector('[data-row-id="1"]') as any).__identityProbe = "kept";
    });

    await page.getByTestId("add").click();

    await expect(page.getByTestId("row")).toHaveCount(4);
    const probe = await page.evaluate(
      () => (document.querySelector('[data-row-id="1"]') as any)?.__identityProbe,
    );
    expect(probe).toBe("kept");
  });

  test("moving one row up preserves every row's identity", async ({ page }) => {
    await page.evaluate(() => {
      for (const id of ["1", "2", "3"]) {
        (document.querySelector(`[data-row-id="${id}"]`) as any).__identityProbe = `n${id}`;
      }
    });

    await page.locator('[data-row-up="2"]').click();

    expect(await rowIds(page)).toEqual(["2", "1", "3"]);
    const probes = await page.evaluate(() =>
      ["1", "2", "3"].map(
        (id) => (document.querySelector(`[data-row-id="${id}"]`) as any)?.__identityProbe,
      ),
    );
    expect(probes).toEqual(["n1", "n2", "n3"]);
  });

  test("badges follow their own rows through a reorder", async ({ page }) => {
    // Guards against keys fixing the <li> while its subtree still gets
    // rewritten from the wrong item's props.
    await page.getByTestId("shuffle").click();

    const pairs = await page.locator("[data-row-id]").evaluateAll((els) =>
      els.map((el) => [
        el.getAttribute("data-row-id"),
        el.querySelector('[data-testid="badge"]')?.textContent,
      ]),
    );
    expect(pairs).toEqual([
      ["3", "T3"],
      ["2", "T2"],
      ["1", "T1"],
    ]);
  });
});

test.describe("diagnostics", () => {
  test("records renders for the mounted component", async ({ page }) => {
    const renders = await page.evaluate(() =>
      (window as any).__semaDiagnostics().filter((e: any) => e.kind === "render"),
    );
    expect(renders.length).toBeGreaterThan(0);
    expect(renders[0].context).toBe("component:app-root");
    expect(typeof renders[0].durationMs).toBe("number");
  });

  test("reports no duplicate-key warnings for a well-formed list", async ({ page }) => {
    // Dev mode is on, so a spurious warning here would mean the detector
    // mis-fires on ordinary unique keys.
    const dupes = await page.evaluate(() =>
      (window as any)
        .__semaDiagnostics()
        .filter((e: any) => String(e.context).startsWith("sip-render:duplicate-key")),
    );
    expect(dupes).toEqual([]);
  });
});
