import { test, expect, chromium } from "@playwright/test";
import * as path from "path";

test.describe("Live System Health & Diagnostics Drawer (HUD)", () => {
  test("opens diagnostics HUD drawer, displays 6 subsystems, live telemetry, and runs probe", async () => {
    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    const baseUrl = process.env.ROADLENS_BASE_URL ?? "http://127.0.0.1:5173";
    await page.goto(`${baseUrl}/camera`);
    await page.waitForLoadState("networkidle");

    // Click the System Health button in the header action badges
    const healthBtn = page.locator('[data-testid="diagnostics-trigger"]');
    await expect(healthBtn).toBeVisible();
    await healthBtn.click();

    // Verify Diagnostics Drawer is open
    const drawer = page.locator(".diagnostics-drawer");
    await expect(drawer).toBeVisible();

    // Verify HUD Header
    const title = page.locator(".diagnostics-header h2");
    await expect(title).toContainText("System Health & Diagnostics HUD");

    // Verify Health Banner & Health Score
    const banner = page.locator(".health-banner");
    await expect(banner).toBeVisible();
    const scoreVal = page.locator(".score-num");
    await expect(scoreVal).toBeVisible();

    // Verify 6 subsystem cards
    const subCards = page.locator(".subsystem-card");
    await expect(subCards).toHaveCount(6);

    // Verify Logs Terminal is populated
    const terminal = page.locator(".logs-terminal");
    await expect(terminal).toBeVisible();
    const logItems = page.locator(".log-row");
    expect(await logItems.count()).toBeGreaterThan(0);

    // Click 'Probe Now' button
    const probeBtn = page.locator("button:has-text('Probe Now')");
    await expect(probeBtn).toBeVisible();
    await probeBtn.click();

    // Wait 500ms for probe results to render
    await page.waitForTimeout(600);

    // Save visual evidence artifact
    const artifactPath =
      "/Users/rushikeshkevale/.gemini/antigravity-ide/brain/92a8764f-05b9-4539-a77f-8e95d0f409ac/diagnostics_hud_verified.png";
    await page.screenshot({ path: artifactPath });

    // Test filter tabs: click 'Errors' filter
    const errorTab = page.locator(".filter-tab.error");
    await errorTab.click();
    await page.waitForTimeout(200);

    // Switch back to 'All'
    const allTab = page.locator(".filter-tab:has-text('All')");
    await allTab.click();

    // Close the drawer
    const closeBtn = page.locator(".diag-close-btn");
    await closeBtn.click();
    await expect(drawer).toBeHidden();

    await browser.close();
  });
});
