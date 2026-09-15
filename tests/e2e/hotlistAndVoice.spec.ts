import { test, expect, chromium } from "@playwright/test";

test.describe("Real-Time BOLO Hotlist Alarms & Hands-Free Voice Control", () => {
  test("opens hotlist drawer, manages watchlist, verifies voice mic button, and captures visual evidence", async () => {
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

    // 1. Verify Hotlist trigger button in header
    const hotlistBtn = page.locator('[data-testid="hotlist-trigger"]');
    await expect(hotlistBtn).toBeVisible();
    await hotlistBtn.click();

    // 2. Verify Hotlist Drawer opens
    const drawer = page.locator(".hotlist-drawer");
    await expect(drawer).toBeVisible();

    const title = page.locator(".hotlist-header h2");
    await expect(title).toContainText("BOLO Watchlist & Alarms");

    // 3. Switch to Watchlist tab
    const watchlistTab = page.locator(".hotlist-tab-btn:has-text('Watchlist')");
    await watchlistTab.click();

    // Verify existing preloaded watchlist items
    const watchlistRows = page.locator(".watchlist-row");
    expect(await watchlistRows.count()).toBeGreaterThanOrEqual(3);

    // 4. Add a new watchlist target plate
    await page.fill(".plate-input", "MH14XY9999");
    await page.fill(".notes-input", "Pune expressway stolen car alert");
    await page.click(".btn-add-entry");

    // Verify feedback toast and new entry in list
    const feedbackToast = page.locator(".hotlist-feedback-toast");
    await expect(feedbackToast).toBeVisible();
    await expect(page.locator(".watchlist-row:has-text('MH14XY9999')")).toBeVisible();

    // 5. Switch to Alarm Settings tab
    const settingsTab = page.locator(".hotlist-tab-btn:has-text('Alarm Settings')");
    await settingsTab.click();
    await expect(page.locator(".speed-range-slider")).toBeVisible();

    // Switch back to Watchlist tab and capture Hotlist Drawer visual evidence
    await watchlistTab.click();
    await page.waitForTimeout(300);
    const hotlistArtifactPath =
      "/Users/rushikeshkevale/.gemini/antigravity-ide/brain/92a8764f-05b9-4539-a77f-8e95d0f409ac/bolo_hotlist_drawer_verified.png";
    await page.screenshot({ path: hotlistArtifactPath });

    // 6. Close Hotlist drawer
    const closeBtn = page.locator(".hotlist-close-btn");
    await closeBtn.click();
    await expect(drawer).toBeHidden();

    // 7. Verify Voice Control button in header
    const voiceHeaderBtn = page.locator('[data-testid="voice-control-trigger"]');
    await expect(voiceHeaderBtn).toBeVisible();

    // 8. Open AI Forensic Chatbox
    const forensicBtn = page.locator("button:has-text('AI Forensic Search')");
    await expect(forensicBtn).toBeVisible();
    await forensicBtn.click();

    const chatDrawer = page.locator(".forensic-chat-drawer");
    await expect(chatDrawer).toBeVisible();

    // 9. Verify Voice Mic Button inside Chatbox Input Bar
    const voiceMicBtn = page.locator(".voice-mic-btn");
    await expect(voiceMicBtn).toBeVisible();

    // Take screenshot evidence of open Forensic Chat with Voice Mic button
    const artifactPath =
      "/Users/rushikeshkevale/.gemini/antigravity-ide/brain/92a8764f-05b9-4539-a77f-8e95d0f409ac/hotlist_and_voice_verified.png";
    await page.screenshot({ path: artifactPath });

    await browser.close();
  });
});
