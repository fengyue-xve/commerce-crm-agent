const $ = (id) => document.getElementById(id);
let current = null;
const put = (id, text) => {
  $(id).textContent = text;
};
function list(id, items) {
  $(id).replaceChildren(
    ...items.map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    }),
  );
}
function fact(label, value) {
  const dt = document.createElement("dt"),
    dd = document.createElement("dd");
  dt.textContent = label;
  dd.textContent = value;
  $("facts").append(dt, dd);
}
const reasonLabels = {
  stock_snapshot_stale: "库存快照已过期，不能作为当前库存使用",
  stock_missing: "缺少有效库存",
  replenishment_basis_unverified: "补货建议依据未核实",
  preparation_missing: "未取得同商品准备记录",
  purchase_facts_missing: "没有取得采购事实",
  stock_snapshot_in_future: "库存日期晚于核对日",
  outer_box_mark_missing: "外箱唛字段尚待补全",
  replenishment_missing: "缺少有效补货建议",
};
function syncPresentation(stage = "idle", row = null) {
  put("summary-sku", row?.assessment.scope.sku ?? $("sku").value);
  const replay = (row?.mode ?? $("mode").value) === "historical_replay";
  put("summary-mode", replay ? "历史回放" : "当天核对");
  put("summary-time-note", replay ? "固定业务日 · 2026-09-03" : "按当前 UTC 日期检查时效");
  put(
    "summary-stage",
    stage === "loading"
      ? "正在核对"
      : stage === "reviewed"
        ? "已标记复核"
        : row
          ? row.assessment.status === "blocked"
            ? "校验未通过"
            : "待人工复核"
          : "等待核对",
  );
  $("empty-state").hidden = stage === "result" || stage === "reviewed";
  put("empty-title", stage === "loading" ? "正在核对业务资料" : "从一次事实核对开始");
  put(
    "empty-description",
    stage === "loading"
      ? "正在读取实际业务来源，并整理事实与未知事项。"
      : "先选择商品并起草，核对结果和客户说明会在这里呈现。",
  );
}
function display(row) {
  syncPresentation("result", row);
  current = row;
  $("result").hidden = false;
  $("checked").checked = false;
  $("review").disabled = true;
  put("status", row.assessment.status === "reference" ? "可作资料参考" : "需要人工核实");
  put("result-sku", "本次核对商品：" + row.assessment.scope.sku);
  put(
    "source-failures",
    row.readFailures.length
      ? "部分来源未取得；请先核对供应链服务和资料后重试，不要将缺失当成已完成。"
      : "",
  );
  put("asof", "业务核对日（UTC）：" + row.asOf.slice(0, 10));
  put("received", "实际HTTP取得时间：" + row.receivedAt);
  put(
    "source",
    row.mode === "historical_replay"
      ? "历史回放：以固定业务日评估刚读取的合成数据。不是当天库存。"
      : "当天核对：按真实当前日期检查上游固定快照是否过期。",
  );
  $("facts").replaceChildren();
  const facts = row.assessment.facts;
  if (facts.stock)
    fact("库存快照", facts.stock.snapshotDate + " · 现存 " + facts.stock.quantity + " 件");
  else fact("库存快照", "没有通过时效校验的库存事实");
  if (facts.replenishment)
    fact(
      "整箱补货参考",
      String(facts.replenishment.suggestedQty ?? "未知") +
        " 件 · " +
        ({
          ready: "参考建议",
          reference: "参考建议",
          review_required: "需人工复核",
          insufficient_data: "资料不足",
        }[facts.replenishment.assessmentStatus] || "待核对"),
    );
  if (facts.preparation)
    fact(
      "同SKU准备记录",
      facts.preparation.recordId +
        " · 外箱唛" +
        (facts.preparation.outerBoxMarkPresent ? "已有值" : "尚未补全") +
        " · 业务版本" +
        facts.preparation.businessVersion,
    );
  else fact("发货准备", "未取得；不能推断已完成");
  fact("订单/物流关联", "未接入，不能承诺可分配数量、发货日期或已发货");
  list("unknowns", row.assessment.unknowns);
  list(
    "reasons",
    row.assessment.reasons.length
      ? row.assessment.reasons.map((x) => reasonLabels[x] || x)
      : ["白名单事实校验通过，仍需核实订单与实际履约信息"],
  );
  list("next", row.assessment.nextActions);
  put("draft", row.draft);
  put("review-status", "尚未发送，也未写入完整 CRM。");
  put(
    "requests",
    row.requests.map((r) => r.method + " " + r.path + " → " + (r.status ?? "不可用")).join("\n"),
  );
  list(
    "events",
    row.events.map((e) => e.seq + ". " + e.type),
  );
}
$("generate").onclick = async () => {
  $("generate").disabled = true;
  $("sku").disabled = true;
  $("mode").disabled = true;
  $("result").hidden = true;
  $("error").hidden = true;
  current = null;
  syncPresentation("loading");
  put("progress", "正在读取业务事实并核对资料…");
  try {
    const response = await fetch("/api/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sku: $("sku").value, mode: $("mode").value }),
    });
    const row = await response.json();
    if (!response.ok) throw new Error("本次未取得草稿，请确认供应链演示服务已启动。");
    display(row);
    put("progress", "核对与草稿已完成。请继续检查未知事项。");
  } catch (error) {
    syncPresentation();
    put("error", error.message);
    $("error").hidden = false;
    put("progress", "本次未完成；没有执行客户发送。");
  } finally {
    $("generate").disabled = false;
    $("sku").disabled = false;
    $("mode").disabled = false;
  }
};
$("checked").onchange = () => {
  $("review").disabled =
    !$("checked").checked || !current || current.assessment.status === "blocked";
};
$("review").onclick = async () => {
  if (!current) return;
  const reviewingId = current.id;
  $("review").disabled = true;
  try {
    const response = await fetch("/api/drafts/" + current.id + "/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: current.revision }),
    });
    if (!response.ok) throw new Error();
    if (current?.id !== reviewingId) return;
    syncPresentation("reviewed", current);
    put("review-status", "已标记人工复核。草稿未发送，未写入完整 CRM；重启演示服务会清除记录。");
  } catch {
    if (current?.id !== reviewingId) return;
    put("review-status", "复核状态未确认，请重新核对。没有执行发送。");
    $("review").disabled = false;
  }
};

for (const id of ["sku", "mode"])
  $(id).onchange = () => {
    current = null;
    syncPresentation();
    $("result").hidden = true;
    $("checked").checked = false;
    $("review").disabled = true;
    put("progress", "核对条件已变更，请重新读取事实并起草。");
  };

syncPresentation();
