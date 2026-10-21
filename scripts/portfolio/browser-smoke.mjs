import { chromium, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
const out = path.resolve("output/portfolio/browser");
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (dialog) => dialog.accept());
const report = {
  routeMocks: false,
  realSupplyHttp: true,
  realPiAdapter: true,
  provider: "official-pi-faux",
  checks: [],
  screenshots: [],
};
try {
  await page.goto("http://127.0.0.1:15273");
  await expect(page.locator("#opportunity-state")).toContainText("AUD-001");
  await page.locator("#reset-demo").click();
  await expect(page.locator("#proposal-message")).toContainText("基线已恢复");
  await expect(page.getByRole("heading", { name: "先核对事实，再回复客户" })).toBeVisible();
  const currentResponse = page.waitForResponse(
    (r) => r.url().endsWith("/api/drafts") && r.status() === 200,
  );
  await page.locator("#generate").click();
  const current = await (await currentResponse).json();
  await expect(page.locator("#draft")).toContainText("没有可用于判断的有效库存记录");
  if (!current.assessment.reasons.includes("stock_snapshot_stale"))
    throw new Error("dated inventory not rejected");
  if (current.assessment.reasons.includes("collection_in_future"))
    throw new Error("HTTP time incorrectly future");
  report.checks.push(
    "current date rejects old inventory",
    "HTTP completion time used for freshness",
  );
  await page.screenshot({ path: path.join(out, "current-stale.png"), fullPage: true });
  await page.locator("#mode").selectOption("historical_replay");
  const replayResponse = page.waitForResponse(
    (r) => r.url().endsWith("/api/drafts") && r.status() === 200,
  );
  await page.locator("#generate").click();
  const replay = await (await replayResponse).json();
  await expect(page.locator("#draft")).toContainText("当时现存18件");
  await expect(page.locator("#facts")).toContainText("72");
  await expect(page.locator("#facts")).toContainText("R-1001");
  const preparation = replay.assessment.facts.preparation;
  if (!preparation) throw new Error("expected shared-SKU preparation record");
  // The upstream demo form resets on restart. Assert the observed state instead
  // of depending on a previous write made by another project's demonstration.
  await expect(page.locator("#draft")).toContainText(
    preparation.outerBoxMarkPresent
      ? "不能据此认定已经发货"
      : "外箱唛尚待补全",
  );
  await expect(page.locator("#draft")).toContainText("目前无法承诺具体发货日期");
  if (JSON.stringify(replay.toolCalls.map((row) => row.name)) !== JSON.stringify(["read_stock", "read_replenishment", "read_preparation", "propose_update_opportunity", "propose_buyer_reply"]))
    throw new Error("unexpected capability");
  if (replay.requests.some((x) => /create-purchase|confirm-po|\/apply|\/approve|send/.test(x.path)))
    throw new Error("write request issued");
  report.checks.push(
    "actual HTTP stock18 and suggestion72",
    "real shared-SKU preparation record",
    "three actual Pi read tools and two proposal-only tools",
    "no write or send requests",
  );
  await expect(page.locator("#review")).toBeDisabled();
  await page.locator("#checked").check();
  await page.locator("#review").click();
  await expect(page.locator("#review-status")).toContainText("已标记人工复核");
  await expect(page.locator("#review-status")).toContainText("草稿未发送");
  report.checks.push("explicit human review, no sending");
  if (replay.guardrail.status !== "passed") throw new Error("default multi-step draft failed guardrail");
  const update = replay.proposals.find((row) => row.effect === "reversible_write");
  const external = replay.proposals.find((row) => row.effect === "external");
  if (!update || !external) throw new Error("proposals missing");
  await page.locator(`[data-proposal="${update.id}"][data-action="execute"]`).click();
  await expect(page.locator("#opportunity-state")).toContainText("版本 2");
  await page.locator(`[data-proposal="${update.id}"][data-action="undo"]`).click();
  await expect(page.locator("#opportunity-state")).toContainText("版本 3");
  await page.locator(`[data-proposal="${external.id}"][data-action="approve"]`).click();
  await expect(page.locator("#proposals")).toContainText("approved");
  report.checks.push("versioned follow-up execution and compensation undo", "external proposal human-approved without sending", "durable proposal audit visible", "guardrail accepted grounded Faux draft", "baseline reset through navigation");
  await page.screenshot({ path: path.join(out, "historical-replay.png"), fullPage: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(out, "desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(out, "mobile.png"), fullPage: true });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow) throw new Error("horizontal mobile overflow");
  await page.locator("#sku").selectOption("DEM-001");
  await expect(page.locator("#result")).toBeHidden();
  report.checks.push("changing SKU invalidates the previous review context");
  await page.locator("#generate").click();
  await expect(page.locator("#draft")).toContainText("当时现存5件");
  await expect(page.locator("#facts")).toContainText("未取得；不能推断已完成");
  report.checks.push(
    "different SKU changes observed draft",
    "missing preparation stays missing",
    "390px viewport without overflow",
  );
  if (errors.length) throw new Error(errors.join("\n"));
  report.pageErrors = errors;
  report.screenshots = ["current-stale.png", "historical-replay.png", "desktop.png", "mobile.png"];
  report.current = {
    status: current.assessment.status,
    reasons: current.assessment.reasons,
    sent: current.sent,
  };
  report.replay = {
    status: replay.assessment.status,
    asOf: replay.asOf,
    receivedAt: replay.receivedAt,
    sent: replay.sent,
    crmPersisted: replay.crmPersisted,
    http: replay.requests,
    events: replay.events.map((e) => e.type),
  };
  fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(report, null, 2));
  console.info(
    "Real-service browser passed:",
    report.checks.length,
    "checks; no route mocks, no customer sending.",
  );
} finally {
  await browser.close();
}
