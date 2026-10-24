# CRM portfolio regression manifest

这份清单固定了当前仓库可复核的履约回归口径。主计数来自 `package.json` 的
`portfolio:test` 命令，统计源码中的静态 `it(...)`、`test(...)`、`it.each(...)`
和 `test.each(...)` 调用点；参数化用例的展开数量另列。`expect(...)` 调用数只作为
辅助信息，不与测试用例数相加。跨进程脚本没有 `it/test` 调用，单独记录脚本声明的
检查数，不并入主计数。

当前主计数为 **104 个静态测试调用点**：履约与护栏 69 个，操作事实桥 4 个，Pi
runtime 31 个。仓库中此前 README 与架构文档使用的旧三位数口径没有对应的逐文件
统计来源，因此以这份可复核清单中的 104 作为当前口径。

## `portfolio:test` 文件清单

| 类别 | 文件 | 静态 `it/test` | 静态 `expect` | 说明 |
| --- | --- | ---: | ---: | --- |
| 履约 Agent / provider | `lib/ai/fulfillment/agent.test.ts` | 6 | 25 | `generateAgentDraft` 与 provider 配置路径 |
| 履约 Agent / HTTP provider | `lib/ai/fulfillment/compatible-http.test.ts` | 1 | 8 | 本地兼容 HTTP provider、工具观察与护栏反馈 |
| 确定性草稿 | `lib/ai/fulfillment/draft.test.ts` | 12 | 64 | 缺失证据、草稿生成与安全回退 |
| Evidence schema / freshness | `lib/ai/fulfillment/evidence.test.ts` | 19 | 60 | 组织、SKU、时效、部分失败与状态判断 |
| 输出护栏 | `lib/ai/fulfillment/output-guardrail.test.ts` | 8 | 10 | 数量、单位、发货承诺与纠错反馈 |
| 提案持久化 / Undo | `lib/ai/fulfillment/proposal-store.test.ts` | 10 | 25 | 文件锁、generation、版本冲突与补偿撤销 |
| Supply Chain Reader | `lib/ai/fulfillment/supply-chain-reader.test.ts` | 13 | 56 | 只读工具、组织与 SKU 隔离、回执与失败 |
| **履约与护栏小计** | 以上 7 个文件 | **69** | **248** | `it/test` 静态调用点 |
| 操作事实桥 | `lib/agent-engine/agent/operational-opening.test.ts` | 4 | 10 | 将已验证事实追加到用户 opening |
| Pi runtime 导入 | `lib/agent-runtime/pi/native-import.test.ts` | 3 | 4 | Pi 原生导入与运行时契约 |
| Pi runtime 主循环 | `lib/agent-runtime/pi/runtime.test.ts` | 25 | 90 | 多步工具观察、停止分类与错误边界 |
| Pi runtime 恢复 | `lib/agent-runtime/pi/resumed-workbench-turn.test.ts` | 3 | 24 | 恢复后的消息、记忆与提交边界 |
| **Pi runtime 小计** | 以上 3 个文件 | **31** | **118** | `it/test` 静态调用点 |
| **主计数合计** | `pnpm portfolio:test` 的 11 个测试文件 | **104** | **376** | `69 + 4 + 31` |

## 跨进程 E2E / smoke

这些脚本由 README 的演示命令单独启动，不属于 `portfolio:test` 的 104 个静态调用点。

| 文件 | 事实口径 |
| --- | --- |
| `scripts/portfolio/browser-smoke.mjs` | 真实浏览器、真实本地 HTTP、真实 Pi Faux 适配器；源码中 `report.checks.push` 声明 15 项检查，另有页面断言与禁止写请求检查。 |
| `scripts/portfolio/persistence-smoke.py` | 真实 HTTP 与自有进程重启；结果对象声明 `checks_passed: 7`，源码有 3 个 Python `assert` 语句。 |
| `scripts/portfolio/live-smoke.py` | 运行中的非 Faux provider 发送 2 个已见问题，按 guardrail、有效库存和 `sent=false` 汇总通过状态；没有固定的 `it/test` 计数。 |

## 运行入口

`package.json` 的 `portfolio:test` 实际命令为：

```text
vitest run lib/ai/fulfillment lib/agent-engine/agent/operational-opening.test.ts lib/agent-runtime/pi/native-import.test.ts lib/agent-runtime/pi/runtime.test.ts lib/agent-runtime/pi/resumed-workbench-turn.test.ts
```

`.github/workflows/portfolio.yml` 的单元步骤运行完整 `pnpm test:unit`，并不把上述
跨进程 smoke 或 `portfolio:test` 子集重新命名为更大的总数。该清单因此把主计数、
参数化展开和跨进程检查分别列出，避免把不同口径相加。
