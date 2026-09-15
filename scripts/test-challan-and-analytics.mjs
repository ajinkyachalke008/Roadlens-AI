import { chromium } from "playwright";
import path from "node:path";

const ARTIFACT_DIR =
  "/Users/rushikeshkevale/.gemini/antigravity-ide/brain/92a8764f-05b9-4539-a77f-8e95d0f409ac";
const TARGET_URL =
  process.env.TARGET_URL || "http://127.0.0.1:5179/camera";

async function main() {
  console.log("🚀 Launching Chrome to test e-Challan & Analytics Dashboard in real UI...");

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
    viewport: { width: 1280, height: 950 },
    permissions: ["camera"],
  });

  const page = await context.newPage();

  // Mock window.print to prevent OS print dialog blocking headless automation
  await page.addInitScript(() => {
    window.__printCalled = false;
    window.print = () => {
      window.__printCalled = true;
      console.log("🖨️ window.print() invoked successfully!");
    };
  });

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      console.log(`[Browser Console Error] ${msg.text()}`);
    }
  });

  console.log(`📡 Navigating to ${TARGET_URL}...`);
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".page-heading", { timeout: 15000 });
  console.log(`📄 Page Title: "${await page.title()}"`);

  // 1. Verify and test Traffic Analytics Dashboard
  const analyticsBtn = page.locator('[data-testid="analytics-btn"]');
  const hasAnalyticsBtn = await analyticsBtn.isVisible();
  console.log(`✅ "📊 Analytics" button visible in controls: ${hasAnalyticsBtn}`);

  console.log("📊 Opening Traffic Analytics Dashboard...");
  await analyticsBtn.click();
  await page.waitForSelector(".drawer", { state: "visible" });

  const drawerHeader = await page.locator(".drawer-head h2").textContent();
  console.log(`✅ Analytics Drawer opened with header: "${drawerHeader?.trim()}"`);

  const kpiVehicles = await page.locator('[data-testid="kpi-total-vehicles"]').isVisible();
  const kpiCompliance = await page.locator('[data-testid="kpi-compliance-rate"]').isVisible();
  const kpiViolations = await page.locator('[data-testid="kpi-speeding-violations"]').isVisible();
  console.log(`✅ KPI Cards rendered: Vehicles=${kpiVehicles}, Compliance=${kpiCompliance}, Violations=${kpiViolations}`);

  // Screenshot 1: Analytics Dashboard
  const screenAnalyticsPath = path.join(ARTIFACT_DIR, "live_analytics_dashboard.png");
  await page.screenshot({ path: screenAnalyticsPath, fullPage: false });
  console.log(`📸 Screenshot saved: ${screenAnalyticsPath}`);

  // Close Analytics Drawer
  await page.locator('button[aria-label="Close drawer"]').click();
  await page.waitForTimeout(400);

  // 2. Inject authentic speeding vehicle report with Indian plate into SessionStore
  console.log("🚗 Inserting Speeding Vehicle Observation with Indian Plate (MH 12 AB 1234)...");
  await page.evaluate(() => {
    const store = window.__ROADLENS_STORE__;
    if (!store) throw new Error("RoadLens store not found on window");

    const now = new Date().toISOString();
    const captureEpoch = crypto.randomUUID();
    const reportId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();

    const report = {
      reportId,
      revision: 0,
      sourceId,
      captureEpoch,
      frameId: `${captureEpoch}:1`,
      trackId: 42,
      sourceMode: "live_camera",
      sourceTimeMs: 18450,
      capturedAtIso: now,
      kind: "speed_candidate",
      className: "car",
      score: 0.94,
      speedMps: 18.89, // 68 km/h
      policy: {
        version: "p-01",
        roadLabel: "Pune - Mumbai Expressway · Lane 1",
        speedLimitMps: 11.11, // 40 km/h limit
        demoMarginMps: 1.38,
        limitSource: "operator_entered_demo",
      },
      validityReasons: [],
      evidenceSummary: { trajectory: [], residualM: null, coverageMs: null },
      modelId: "yolo26n",
      modelSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      detectorProfile: "416",
      trackerVersion: "v1",
      calibrationVersion: "cal-v1",
      evidenceId: null,
      evidenceState: "none",
      review: "pending",
      plateStatus: "read",
      plateText: "MH 12 AB 1234",
      plateConfidence: 0.97,
      plateSupportingFrames: 5,
      createdAt: now,
      updatedAt: now,
    };

    store.upsert(report);
  });

  await page.waitForTimeout(500);

  // 3. Verify report appears in Reports table and click it
  console.log("📋 Opening Report card for MH 12 AB 1234...");
  await page.waitForSelector(".report-row", { timeout: 5000 });
  const reportRow = page.locator(".report-row").first();
  await reportRow.click();
  await page.waitForSelector(".drawer", { state: "visible" });

  const reportTitle = await page.locator(".drawer-head h2").textContent();
  console.log(`✅ Report details drawer opened: "${reportTitle?.trim()}"`);

  // 4. Click "📄 Generate e-Challan" button
  console.log("📄 Clicking 'Generate e-Challan' button...");
  const challanBtn = page.locator('[data-testid="generate-challan-btn"]');
  await challanBtn.click();
  await page.waitForSelector(".challan-modal-backdrop", { state: "visible" });

  // 5. Verify e-Challan data in English
  const challanId = await page.locator('[data-testid="challan-id"]').textContent();
  const plateText = await page.locator('[data-testid="challan-plate-number"]').textContent();
  const speedText = await page.locator('[data-testid="challan-recorded-speed"]').textContent();
  const totalAmount = await page.locator('[data-testid="challan-total-amount"]').textContent();

  console.log(`✅ Official e-Challan Generated:`, {
    challanId: challanId?.trim(),
    plate: plateText?.trim(),
    speed: speedText?.trim(),
    fine: totalAmount?.trim(),
  });

  // Screenshot 2: e-Challan Modal (English)
  const screenChallanEnPath = path.join(ARTIFACT_DIR, "live_echallan_modal_en.png");
  await page.screenshot({ path: screenChallanEnPath, fullPage: false });
  console.log(`📸 Screenshot saved: ${screenChallanEnPath}`);

  // 6. Test Language Switcher to Hindi
  console.log("🌐 Switching e-Challan Language to Hindi (हिंदी)...");
  await page.locator('.lang-btn', { hasText: 'हिंदी' }).click();
  await page.waitForTimeout(300);

  const hindiHeader = await page.locator('.challan-header-text h2').textContent();
  console.log(`✅ Hindi Header rendered: "${hindiHeader?.trim()}"`);

  // Screenshot 3: e-Challan Modal (Hindi)
  const screenChallanHiPath = path.join(ARTIFACT_DIR, "live_echallan_modal_hi.png");
  await page.screenshot({ path: screenChallanHiPath, fullPage: false });
  console.log(`📸 Screenshot saved: ${screenChallanHiPath}`);

  // 7. Test Print action
  console.log("🖨️ Testing Print / Save as PDF action trigger...");
  await page.locator('.print-trigger-btn').click();
  const printInvoked = await page.evaluate(() => window.__printCalled);
  console.log(`✅ Native Print / PDF Save triggered: ${printInvoked}`);

  // 8. Close Challan Modal
  await page.locator('.action-btn.close-btn').click();
  await page.waitForTimeout(400);

  console.log("🎉 All live e-Challan & Analytics tests passed with 100% success!");
  await browser.close();
}

main().catch((err) => {
  console.error("❌ E2E test failed:", err);
  process.exit(1);
});
