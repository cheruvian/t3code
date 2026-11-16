import { expect } from "e2e";
import { test, WEB } from "./t3.ts";

test(
  "Sidebar project grouping can be enabled and disabled without losing threads",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const alpha = await t3.project("Review Alpha");
    const beta = await t3.project("Review Beta");
    const thread = await t3.thread({ project: alpha, title: "Alpha review", messages: ["first"] });
    await t3.thread({ project: beta, title: "Beta review", messages: ["first"] });
    await t3.open("/settings/labs");
    const toggle = () => screen.getByRole("switch", "Boring sidebar (group by project)");
    await expect(toggle()).toHaveAttribute("aria-checked", "false");
    await app.screenshot("grouping-disabled-control");
    await t3.open(thread);
    await expect(screen.getByRole("button", "Alpha review,", { exact: false })).toBeVisible();
    await app.screenshot("grouping-disabled-threads");

    await t3.open("/settings/labs");
    await toggle().tap();
    await expect(toggle()).toHaveAttribute("aria-checked", "true");
    await app.screenshot("grouping-enabled-control");
    await t3.open(thread);
    await expect(screen.getByRole("button", "Alpha review,", { exact: false })).toBeVisible();
    expect(
      await browser.evaluate(() => {
        const folders = [...document.querySelectorAll('[data-testid="sidebar-project-folder"]')];
        return ["Review Alpha", "Review Beta"].every((name) =>
          folders.some((folder) => folder.textContent?.includes(name)),
        );
      }),
    ).toBe(true);
    await app.screenshot("grouping-enabled-threads");

    await t3.open("/settings/labs");
    await toggle().tap();
    await expect(toggle()).toHaveAttribute("aria-checked", "false");
    await t3.open(thread);
    await expect(screen.getByRole("button", "Alpha review,", { exact: false })).toBeVisible();
    await expect(screen.getByRole("button", "Beta review,", { exact: false })).toBeVisible();
    expect(
      await browser.evaluate(
        () => document.querySelectorAll('[data-testid="sidebar-project-folder"]').length,
      ),
    ).toBe(0);
    await app.screenshot("grouping-disabled-again");
  },
);
