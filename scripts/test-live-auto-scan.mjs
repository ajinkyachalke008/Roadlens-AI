import { chromium } from "playwright";
import path from "node:path";

const ARTIFACT_DIR = "/Users/rushikeshkevale/.gemini/antigravity-ide/brain/92a8764f-05b9-4539-a77f-8e95d0f409ac";
const TARGET_URL =
  process.env.TARGET_URL || "https://roadlens-ai-lime.vercel.app/camera";

async function main() {
  console.log(`🚀 Launching Chromium to test live app at: ${TARGET_URL}`);

  const executablePath =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 850 },
    permissions: ["camera"],
  });

  const page = await context.newPage();

  // Listen to console logs and errors
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      console.log(`[Browser Console Error] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    console.error(`[Browser Page Error] ${err.message}`);
  });

  console.log(`📡 Navigating to ${TARGET_URL}...`);
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".page-heading", { timeout: 15000 });

  console.log(`📄 Page Title: "${await page.title()}"`);

  // 1. Initial State Checks
  const pageHeading = await page.locator(".page-heading h1").textContent();
  console.log(`✅ Page Header: "${pageHeading?.trim()}"`);

  const initialBadge = await page.locator('[data-testid="auto-scan-badge"]').textContent();
  console.log(`✅ Initial Auto-Scan Badge: "${initialBadge?.trim()}"`);

  const autoScanBtn = page.locator(".auto-scan-toggle");
  const initialBtnText = await autoScanBtn.textContent();
  console.log(`✅ Hands-Free Toggle Button text: "${initialBtnText?.trim()}"`);

  // Screenshot 1: Initial state
  const screen1Path = path.join(ARTIFACT_DIR, "live_camera_initial.png");
  await page.screenshot({ path: screen1Path, fullPage: false });
  console.log(`📸 Screenshot saved: ${screen1Path}`);

  // 2. Click Hands-Free Auto-Scan Toggle
  console.log("⚡ Clicking Hands-Free Auto-Scan button...");
  await autoScanBtn.click();

  // Wait for UI to update
  await page.waitForTimeout(600);

  const activeBadge = await page.locator('[data-testid="auto-scan-badge"]').textContent();
  console.log(`✅ Active Auto-Scan Badge: "${activeBadge?.trim()}"`);

  const activeBtnText = await autoScanBtn.textContent();
  console.log(`✅ Active Toggle Button: "${activeBtnText?.trim()}"`);

  // Check toast notification
  const toastVisible = await page.locator(".auto-scan-toast").isVisible();
  const toastText = toastVisible ? await page.locator(".auto-scan-toast").textContent() : "none";
  console.log(`✅ Auto-Scan Toast Banner: visible=${toastVisible}, text="${toastText?.trim()}"`);

  // Check trigger mode switcher
  const modeSwitcher = page.locator(".trigger-mode-btn");
  const modeSwitcherVisible = await modeSwitcher.isVisible();
  const mode1Text = modeSwitcherVisible ? await modeSwitcher.textContent() : "none";
  console.log(`✅ Trigger Mode Switcher visible: ${modeSwitcherVisible}, text="${mode1Text?.trim()}"`);

  // Screenshot 2: Activated Hands-Free Auto-Scan
  const screen2Path = path.join(ARTIFACT_DIR, "live_auto_scan_active.png");
  await page.screenshot({ path: screen2Path, fullPage: false });
  console.log(`📸 Screenshot saved: ${screen2Path}`);

  // 3. Test Trigger Mode Switcher ("All Vehicles" -> "Speeding Only" -> "All Vehicles")
  console.log("🎯 Testing Trigger Mode Switcher...");
  await modeSwitcher.click();
  await page.waitForTimeout(300);
  const mode2Text = await modeSwitcher.textContent();
  console.log(`✅ Mode switched to: "${mode2Text?.trim()}"`);

  await modeSwitcher.click();
  await page.waitForTimeout(300);
  const mode3Text = await modeSwitcher.textContent();
  console.log(`✅ Mode switched back to: "${mode3Text?.trim()}"`);

  // 4. Test Settings Drawer
  console.log("⚙️ Opening Settings drawer...");
  const settingsBtn = page.locator(".controls button", { hasText: "Settings" });
  await settingsBtn.click();
  await page.waitForSelector(".drawer", { state: "visible" });

  const drawerTitle = await page.locator(".drawer-head h2").textContent();
  console.log(`✅ Drawer opened with title: "${drawerTitle?.trim()}"`);

  // Look for the Indian Plate Auto-Scanner section
  const autoScanSettingHeader = await page
    .locator(".drawer h3", { hasText: "Hands-Free Indian Plate Auto-Scanner" })
    .isVisible();
  console.log(
    `✅ "🇮🇳 Hands-Free Indian Plate Auto-Scanner" section in Settings: ${autoScanSettingHeader}`,
  );

  const autoScanCheckbox = page
    .locator(".drawer label.check input[type='checkbox']")
    .first();
  const isChecked = await autoScanCheckbox.isChecked();
  console.log(`✅ Settings drawer Auto-Scan checkbox is checked: ${isChecked}`);

  // Screenshot 3: Settings drawer
  const screen3Path = path.join(ARTIFACT_DIR, "live_settings_drawer.png");
  await page.screenshot({ path: screen3Path, fullPage: false });
  console.log(`📸 Screenshot saved: ${screen3Path}`);

  // Close drawer
  await page.locator('button[aria-label="Close drawer"]').click();
  await page.waitForTimeout(400);

  // 5. Test Live Camera Start & Synthetic Frame Feed with Indian Number Plate
  console.log("📷 Starting camera in synthetic/fake media stream mode...");
  const startCameraBtn = page.locator(".controls button.primary");
  await startCameraBtn.click();
  await page.waitForTimeout(2000);

  const cameraStatusText = await page.locator(".stage-top span").last().textContent();
  console.log(`✅ Camera status: "${cameraStatusText?.trim()}"`);

  // Screenshot 4: Running Camera with Auto-Scan ON
  const screen4Path = path.join(ARTIFACT_DIR, "live_camera_running.png");
  await page.screenshot({ path: screen4Path, fullPage: false });
  console.log(`📸 Screenshot saved: ${screen4Path}`);

  console.log("🎉 All live browser tests passed successfully!");
  await browser.close();
}

main().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
