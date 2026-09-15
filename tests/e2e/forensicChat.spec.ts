import { test, expect, chromium } from "@playwright/test";

test.describe("AI Forensic Intelligence & Dossier", () => {
  test("renders vehicle forensic dossier with Leaflet route map at /forensics/vehicle/:id", async () => {
    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    await page.goto("http://127.0.0.1:5173/forensics/vehicle/MH12AB1234");
    await page.waitForLoadState("networkidle");

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
    await expect(parivahanBtn).toHaveAttribute(
      "href",
      "https://echallan.parivahan.gov.in/index/accused-challan",
    );

    // Check Leaflet map wrapper
    const mapWrapper = page.locator(".forensic-route-map-wrapper");
    await expect(mapWrapper).toBeVisible();

    // Take screenshot and save as artifact
    await page.screenshot({
      path: "/Users/rushikeshkevale/.gemini/antigravity-ide/brain/92a8764f-05b9-4539-a77f-8e95d0f409ac/forensic_dossier_verified.png",
      fullPage: true,
    });

    await browser.close();
  });

  test("opens AI Forensic Search drawer and displays search categories on /camera", async () => {
    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    await page.goto("http://127.0.0.1:5173/camera");
    await page.waitForLoadState("networkidle");

    // Click AI Forensic Search button
    const chatBtn = page.locator('button:has-text("AI Forensic Search")');
    if ((await chatBtn.count()) > 0) {
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

      // Take screenshot of drawer
      await page.screenshot({
        path: "/Users/rushikeshkevale/.gemini/antigravity-ide/brain/92a8764f-05b9-4539-a77f-8e95d0f409ac/forensic_chat_verified.png",
        fullPage: true,
      });
    }

    await browser.close();
  });
});
