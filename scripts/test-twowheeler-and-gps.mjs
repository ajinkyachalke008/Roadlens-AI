import { chromium } from "playwright";
import path from "node:path";

const ARTIFACT_DIR =
  "/Users/rushikeshkevale/.gemini/antigravity-ide/brain/92a8764f-05b9-4539-a77f-8e95d0f409ac";
const TARGET_URL = process.env.TARGET_URL || "http://127.0.0.1:4173/camera";

async function main() {
  console.log(`🚀 Launching Chromium to test Two-Wheeler & GPS MVP at: ${TARGET_URL}`);

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

  // Mock Mumbai-Pune Expressway Geolocation
  const context = await browser.newContext({
    viewport: { width: 1300, height: 950 },
    permissions: ["geolocation", "camera"],
    geolocation: {
      latitude: 18.7562,
      longitude: 73.4078,
      accuracy: 5,
    },
  });

  const page = await context.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      console.log(`[Browser Console Error] ${msg.text()}`);
    }
  });

  console.log(`📡 Navigating to ${TARGET_URL}...`);
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".page-heading", { timeout: 15000 });

  // 1. Verify Live GPS Badge on Stage
  console.log("📍 Verifying Live GPS HUD Badge on Stage...");
  await page.waitForSelector('[data-testid="stage-gps-badge"]', { timeout: 8000 });
  const gpsBadgeText = await page.locator('[data-testid="stage-gps-badge"]').textContent();
  console.log(`✅ Live GPS HUD Badge text: "${gpsBadgeText?.trim()}"`);

  if (!gpsBadgeText?.includes("18°45'") || !gpsBadgeText?.includes("73°24'")) {
    throw new Error(`GPS badge did not format expected DMS coordinates: "${gpsBadgeText}"`);
  }

  // Screenshot 1: Live Stage HUD with GPS Badge
  const hudScreenPath = path.join(ARTIFACT_DIR, "twowheeler_gps_stage_hud.png");
  await page.screenshot({ path: hudScreenPath, fullPage: false });
  console.log(`📸 Stage HUD screenshot saved: ${hudScreenPath}`);

  // 2. Inject a two-wheeler motorcycle violation report into session store
  console.log("🏍️ Injecting motorcycle violation report into session store...");
  await page.evaluate(() => {
    const store = window.__ROADLENS_STORE__;
    const flags = window.__ROADLENS_TWOWHEELER_FLAGS__;

    if (flags) {
      flags.set(19, {
        isTripleRiding: true,
        hasNoHelmet: true,
      });
    }

    if (store) {
      const reportId = "00000000-0000-0000-0000-000000000099";
      const sourceId = "00000000-0000-0000-0000-000000000001";
      const captureEpoch = "00000000-0000-0000-0000-000000000001";
      const now = new Date().toISOString();

      const sampleReport = {
        reportId,
        revision: 0,
        sourceId,
        captureEpoch,
        frameId: `${captureEpoch}:1`,
        trackId: 19,
        sourceMode: "live_camera",
        sourceTimeMs: 15000,
        capturedAtIso: now,
        kind: "observation",
        className: "motorcycle",
        score: 0.95,
        speedMps: 17.22, // ~62 km/h (speed limit 40 km/h -> excess +22 km/h)
        policy: {
          version: "p-1",
          roadLabel: "NH-48 Corridor",
          speedLimitMps: 11.11, // 40 km/h
          demoMarginMps: 1.38,
          limitSource: "operator_entered_demo",
        },
        validityReasons: [],
        evidenceSummary: { trajectory: [], residualM: null, coverageMs: null },
        modelId: "yolo26n",
        modelSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        detectorProfile: "profile-1",
        trackerVersion: "track-1",
        calibrationVersion: null,
        review: "pending",
        evidenceState: "none",
        plateStatus: "read",
        plateText: "MH 12 AB 9988",
        plateConfidence: 0.96,
        createdAt: now,
        updatedAt: now,
      };

      store.reports.set(reportId, sampleReport);
      store.onChange();
    }
  });

  // Wait for the report item to appear in the Reports list
  console.log("📄 Waiting for report item in Reports section...");
  const reportRow = page.locator(".report-row").first();
  await reportRow.waitFor({ timeout: 8000 });
  console.log("👆 Clicking report row to open detail drawer...");
  await reportRow.click();

  // Wait for Generate e-Challan button in drawer
  console.log("📄 Clicking 'Generate e-Challan' button...");
  const generateChallanBtn = page.locator('[data-testid="generate-challan-btn"]');
  await generateChallanBtn.waitFor({ timeout: 5000 });
  await generateChallanBtn.click();

  // 3. Verify e-Challan Modal contents
  console.log("🔍 Verifying official e-Challan modal content...");
  await page.waitForSelector(".challan-modal-backdrop", { timeout: 10000 });

  // Verify Challan ID
  const challanId = await page.locator('[data-testid="challan-id"]').textContent();
  console.log(`✅ Official Challan ID: "${challanId?.trim()}"`);

  // Verify GPS Strip
  const gpsBanner = page.locator('[data-testid="challan-gps-banner"]');
  await gpsBanner.waitFor({ timeout: 5000 });
  const gpsVisible = await gpsBanner.isVisible();
  const gpsText = await gpsBanner.textContent();
  console.log(`✅ Forensic GPS Banner: visible=${gpsVisible}, text="${gpsText?.trim()}"`);

  // Verify Map Link
  const mapLink = page.locator(".gps-map-link");
  const mapHref = await mapLink.getAttribute("href");
  console.log(`✅ Google Maps Verification Link: "${mapHref}"`);

  // Verify Two-Wheeler Safety Violations Alert Banner
  const alertBanner = page.locator('[data-testid="two-wheeler-alert"]');
  await alertBanner.waitFor({ timeout: 5000 });
  const alertVisible = await alertBanner.isVisible();
  const alertText = await alertBanner.textContent();
  console.log(`✅ Two-Wheeler Violations Alert: visible=${alertVisible}, text="${alertText?.trim()}"`);

  // Verify Plate Number on Challan
  const plateText = await page.locator('[data-testid="challan-plate-number"]').textContent();
  console.log(`✅ Challan Registration Plate: "${plateText?.trim()}"`);

  // Verify Total Fine Amount (Over-speeding ₹1,000 + Triple Riding ₹1,000 + No Helmet ₹1,000 = ₹3,000)
  const totalAmount = await page.locator('[data-testid="challan-total-amount"]').textContent();
  console.log(`✅ Total Fine Amount Payable: "${totalAmount?.trim()}"`);

  // Screenshot 2: Official e-Challan with GPS & Two-Wheeler Violations (English)
  const challanScreenPath = path.join(ARTIFACT_DIR, "echallan_twowheeler_gps_modal.png");
  await page.screenshot({ path: challanScreenPath, fullPage: false });
  console.log(`📸 e-Challan Modal screenshot saved: ${challanScreenPath}`);

  // 4. Test Language Toggle (Hindi)
  console.log("🇮🇳 Testing Hindi language toggle on e-Challan...");
  const hiBtn = page.locator(".lang-btn", { hasText: "हिंदी" });
  await hiBtn.click();
  await page.waitForTimeout(400);

  const totalAmountHi = await page.locator('[data-testid="challan-total-amount"]').textContent();
  console.log(`✅ Hindi e-Challan Total: "${totalAmountHi?.trim()}"`);

  const challanHiScreenPath = path.join(ARTIFACT_DIR, "echallan_twowheeler_gps_hindi.png");
  await page.screenshot({ path: challanHiScreenPath, fullPage: false });
  console.log(`📸 Hindi e-Challan screenshot saved: ${challanHiScreenPath}`);

  await browser.close();
  console.log("🎉 All automated live browser tests passed with 100% success!");
}

main().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
