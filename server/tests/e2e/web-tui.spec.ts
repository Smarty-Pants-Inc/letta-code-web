import { expect, test } from "@playwright/test";

test("desktop: message -> overlay -> approval", async ({ page }) => {
  await page.goto("/");

  const terminalLog = page.getByTestId("terminal-log");
  await expect(terminalLog).toContainText("Mock Letta Code Web TUI Runner", {
    timeout: 30_000,
  });

  const composer = page.getByLabel("Message");

  await composer.fill("hello");
  await page.keyboard.press("Enter");
  await expect(terminalLog).toContainText("echo: hello");

  await composer.fill("/model");
  await page.keyboard.press("Enter");

  const overlay = page.getByRole("dialog", { name: "Overlay" });
  await expect(overlay).toBeVisible();
  await overlay.getByRole("button", { name: /Mock Model B/ }).click();
  await expect(overlay).toBeHidden();
  await expect(terminalLog).toContainText("Selected model: mock-model-b");

  await composer.fill("/mock approval");
  await page.keyboard.press("Enter");

  const approval = page.getByRole("dialog", { name: "Approval" });
  await expect(approval).toBeVisible();
  await approval.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(approval).toBeHidden();
  await expect(terminalLog).toContainText("Approved current");
});

test("desktop: AskUserQuestion tool-ui does not leak into later approvals", async ({
  page,
}) => {
  await page.goto("/");

  const terminalLog = page.getByTestId("terminal-log");
  await expect(terminalLog).toContainText("Mock Letta Code Web TUI Runner", {
    timeout: 30_000,
  });

  const composer = page.getByLabel("Message");

  await composer.fill("/mock question");
  await page.keyboard.press("Enter");

  const approval = page.getByRole("dialog", { name: "Approval" });
  await expect(approval).toBeVisible({ timeout: 30_000 });
  await expect(approval).toContainText("POC Help", { timeout: 30_000 });

  const options = page.locator(".sheet .modalList button");
  await expect(options).toHaveCount(4);
  await options.first().click();
  await expect(approval).toBeHidden();

  await composer.fill("/mock approval");
  await page.keyboard.press("Enter");

  await expect(approval).toBeVisible();
  await expect(approval).toContainText("Approval required");
  await expect(approval).toContainText("Bash");
  await expect(approval).not.toContainText("POC Help");
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("mobile: composer usable", async ({ page }) => {
    await page.goto("/");

    const terminalLog = page.getByTestId("terminal-log");
    await expect(terminalLog).toContainText("Mock Letta Code Web TUI Runner", {
      timeout: 30_000,
    });

    const composer = page.getByLabel("Message");
    await expect(composer).toBeVisible();

    await composer.fill("hi from mobile");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("terminal-log")).toContainText(
      "echo: hi from mobile",
    );
  });
});
