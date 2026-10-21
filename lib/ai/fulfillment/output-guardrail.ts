import { z } from "zod";
import type { OperationalEvidenceReport } from "./evidence";

export const customerOutputSchema = z.strictObject({
  reply: z.string().trim().min(1).max(6000),
  claims: z.array(z.strictObject({
    kind: z.enum(["stock", "replenishment"]),
    quantity: z.number().int().nonnegative(),
  })).max(20),
});
export type CustomerOutput = z.infer<typeof customerOutputSchema>;

function numeral(value: string): number {
  value = value.replace(/\s+/g, "").replace("−", "-");
  if (value.startsWith("-")) return -numeral(value.slice(1));
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
  let result = 0, current = 0;
  for (const char of value) {
    if (digits[char] !== undefined) current = current * 10 + digits[char]!;
    else if (units[char]) { result += (current || 1) * units[char]!; current = 0; }
    else return Number.NaN;
  }
  return result + current;
}

/** Conservative deterministic checks, not a claim of universal natural-language verification. */
export function guardCustomerOutput(
  candidate: unknown,
  report: OperationalEvidenceReport,
): { ok: boolean; violations: string[]; output: CustomerOutput | null } {
  const parsed = customerOutputSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, violations: ["output_schema: return JSON {reply, claims:[{kind,quantity}]}"], output: null };
  const output = parsed.data;
  const violations: string[] = [];
  const quantities = {
    stock: report.facts.stock?.quantity,
    replenishment: report.facts.replenishment?.suggestedQty ?? undefined,
  };
  for (const claim of output.claims) {
    if (report.status === "blocked" || quantities[claim.kind] !== claim.quantity)
      violations.push(`unsupported_${claim.kind}_quantity:${claim.quantity}`);
  }
  // Check each clause: a disclaimer in a different clause never licenses a promise.
  const clauses = output.reply.split(/[，,。.!！?？;；\n]|但是|不过|然而|\bbut\b|\bhowever\b|但/i);
  for (const clause of clauses) {
    const promises = /(?:保证|承诺|确保|一定|肯定|可以|能够|将会|会在|已经|已于|预计)[^，。;；\n]{0,18}(?:发货|出库|送达|到货|揽收)|(?:今天|明天|后天|今日|明日|周[一二三四五六日天]|星期[一二三四五六日天]|\d+\s*(?:天|小时|个工作日)内|\d+月\d+日)[^，。;；\n]{0,12}(?:发货|出库|送达)|已(?:经)?(?:发货|出库|揽收|发送)|可(?:立即|直接)?发货|(?:可分配|可发|能发)\s*(?:\d+|[一二三四五六七八九十]+)?\s*(?:件|个|箱|库存|货)|\b(?:will|guarantee[ds]?|definitely|already|can)\b.{0,30}\b(?:ship|shipped|deliver|dispatched|sent)\b/gi;
    for (const match of clause.matchAll(promises)) {
      const prefix = clause.slice(Math.max(0, match.index! - 12), match.index);
      if (!/(?:不能|无法|不予|不作|不代表|不等于|尚未|未能|未|不|不是|并非|cannot|can't|not|never)[^，。;；\n]{0,8}$/i.test(prefix))
        violations.push("shipment_promise_forbidden");
    }
    const quantityPattern = /([-−]?\s*(?:[0-9]+|[零〇一二两三四五六七八九十百千万]+))\s*(件|个|箱|boxes?\b|units?\b|items?\b)/gi;
    const inventoryPattern = /(?:库存|现存|可用量|inventory|stock)\s*(?:为|是|有|共|[:：=]|is|of)?\s*([-−]?\s*(?:[0-9]+|[零〇一二两三四五六七八九十百千万]+))/gi;
    for (const match of [...clause.matchAll(quantityPattern), ...clause.matchAll(inventoryPattern)]) {
      const qty = numeral(match[1]!);
      if (/^(?:箱|boxes?)$/i.test(match[2] ?? "")) violations.push("unsupported_quantity_unit");
      const isReplenishment = /补货|采购参考|replenish/i.test(clause) && !/库存|现存|inventory|stock/i.test(clause);
      const kind = isReplenishment ? "replenishment" : "stock";
      if (quantities[kind] === undefined || qty !== quantities[kind] || report.status === "blocked")
        violations.push(`unsupported_${kind}_quantity:${qty}`);
      if (!output.claims.some((claim) => claim.kind === kind && claim.quantity === qty))
        violations.push(`unregistered_${kind}_claim:${qty}`);
    }
  }
  if (report.status === "blocked" && output.claims.length) violations.push("blocked_facts_must_be_empty");
  return { ok: violations.length === 0, violations: [...new Set(violations)], output };
}

export function parseCustomerOutput(text: string): unknown {
  try { return JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); }
  catch { return null; }
}
