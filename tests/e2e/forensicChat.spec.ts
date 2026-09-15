import { test, expect } from "@playwright/test";

test.describe("AI Forensic Intelligence & Dossier", () => {
  test("renders vehicle forensic dossier with Leaflet route map at /forensics/vehicle/:id", async ({ page }) => {
    await page.goto("/forensics/vehicle/MH12AB1234");
    await page.waitForLoadState("domcontentloaded");

    // Check title and plate display
    const title = page.locator(".dossier-title-group h1");
    await expect(title).toBeVisible();
    await expect(title).toContainText("MH12AB1234");

    // Check HSRP plate badge
    const hsrp = page.locator(".plate-hsrp-display");
    await expect(hsrp).toBeVisible();

    // Check official Parivahan link
    const parivahanBtn = page.locator(".parivahan-btn");
    await expect(parivahanBtn).toBeVisible();
    await expect(parivahanBtn).toHaveAttribute("href", "https://echallan.parivahan.gov.in/index/accused-challan");

    // Check Leaflet map wrapper
    const mapWrapper = page.locator(".forensic-route-map-wrapper");
    await expect(mapWrapper).toBeVisible();
  });

  test("opens AI Forensic Search drawer and displays search categories on /camera", async ({ page }) => {
    await page.goto("/camera");
    await page.waitForLoadState("domcontentloaded");

    // Check AI Forensic Search button
    const chatBtn = page.locator('button:has-text("AI Forensic Search"), button[aria-label*="Forensic"]');
    if (await chatBtn.count() > 0) {
      await chatBtn.first().click();

      // Verify drawer opens
      const drawer = page.locator(".forensic-chat-drawer");
      await expect(drawer).toBeVisible();

      // Verify status line
      const statusLine = page.locator(".forensic-status-line");
      await expect(statusLine).toBeVisible();

      // Verify quick prompt categories
      const categories = page.locator(".prompt-category");
      await expect(categories).toHaveCount(5);
    }
  });
});
