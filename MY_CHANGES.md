# 本轮二次开发与个人贡献

本轮完成基于开源 Pi Native CRM 的电商客服履约事实核验、独立草稿演示和真实 CRM 可选服务端接线。日期：2026-10-21。来源见 [UPSTREAM.md](UPSTREAM.md)，测试、构建和全局门禁的最终记录以 [04-verification.md](docs/portfolio/04-verification.md) 为准。

选题来自三个项目的共同问题：内部库存与运营状态已经有查询入口，客服仍可能把这些状态误说成客户订单已经发货。我的工作是划清事实范围，保留日期和来源，让客服拿到可复核草稿与明确下一步。

## 本轮文件

| 工作 | 实际文件 | 实现范围 |
| --- | --- | --- |
| 结构化事实校验与呈现 | `lib/ai/fulfillment/evidence.ts` | 严格输入契约、组织/SKU 一致性、采集时间和快照时效；返回事实、缺口和人工动作，始终不能承诺发货或发送 |
| 供应链只读 HTTP 接入 | `lib/ai/fulfillment/supply-chain-reader.ts` | 以合成 viewer 身份登录第二项目，实际读取库存、补货参考和匹配的表单记录；限制本机 origin、接口与响应字段，保留部分失败 |
| 草稿编排 | `lib/ai/fulfillment/draft.ts` | 当天核对/历史回放模式；实际调用 CRM Pi 适配器，先执行读取工具，再根据校验观察形成确定性草稿 |
| 官方 Faux 工具循环 | `lib/agent-runtime/pi/tool-observation-fixture.ts` | 实际 Pi SDK 和工具执行；脚本化 provider 必须消费工具结果，没有真实 LLM 请求 |
| 真实 CRM 可选事实端口 | `lib/agent-engine/agent/reply-drafts.ts`、`inbound-turn.ts`、`operational-opening.ts`，以及预览输入类型 | 服务端 `generateReplyDraft` 接受可选 `operationalEvidence`，经 preview 进入 `buildOpening`，校验后追加动态上下文；默认 undefined 保持原行为 |
| Windows SDK 加载边界 | `lib/agent-runtime/pi/native-import.ts` 及相邻适配代码 | 识别 Windows 路径中的 tsx worker，保留 Node 原生 ESM import，处理 Pi 仅导出 import 条件的兼容问题 |
| 独立本地演示 | `scripts/portfolio/server.mts`、`demo.py`、`browser-smoke.mjs`；`examples/fulfillment-demo/` 的 HTML/CSS/JS 与示例配置 | 展示来源、HTTP 时间、业务核对日、事实、缺口、Pi 事件和待复核草稿；不依赖完整 CRM 数据库 |
| 来源与学习资料 | `UPSTREAM.md`、本文、`docs/portfolio/` | 保留上游归属、输入摘要、业务边界和可复现验证说明 |

代码中的采购事实类型可接收已核对资料，并用反例确保 `confirmed` 不推导发货；**当前 HTTP reader 不读取采购接口**，viewer 也不能访问管理员采购接口，所以实际演示不会声称知道采购已确认。表单查询只核对同 SKU 的准备字段，不证明该记录属于客户订单。

## 具体执行与验证范围

本轮定向回归分别覆盖纯校验 42 项、reader 20 项、草稿 13 项、opening 4 项及原生加载边界 3 项。实际跨项目 HTTP 已读取第二项目的合成数据，浏览器场景 11 项未使用请求 mock、无 pageerror；详细命令、版本、日志和最终结果见 [验证记录](docs/portfolio/04-verification.md)。既有 runtime 恢复测试的复核另列，不计作本轮新功能测试。全局 typecheck、lint、build 和全量测试的状态也以该记录为准。

独立演示使用官方 Faux provider。`current_check` 按当前日期核对上游固定快照，过期库存不作为当前有效量展示；`historical_replay` 以 2026-09-03 为业务核对日，仍实际发 HTTP 请求，展示 `AUD-001` 的历史库存 18、补货参考 72 及 `R-1001`。合成 SKU `DEM-001` 可读到历史库存 5。HTTP 取得时间与业务核对日分别显示，历史评估不伪装成当天库存。

人工复核只改变本机服务内存中的草稿标记，30 分钟到期或服务重启后不可继续使用；不发送、不写入 CRM，也没有持久审批台账。真实 CRM 只有服务端可选端口；原有 CRM UI 没有事实导入控件，公共 API 不接受客户端提交的运营事实。

## 上游能力与个人学习边界

Next.js CRM、Supabase Auth/RLS、联系人/商机/任务、原有 Pi 适配与工具审批恢复、Mission、多 Agent、Mem0/WeKnora/Langfuse、中文工作台和历史录制均为上游既有能力。本轮复用和复核，不将它们写成独立设计实现。

应重点掌握本轮的输入契约、纯规则、HTTP 失败处理、时间口径、Pi 工具入参/观察/草稿、Windows 模块加载和人工复核边界。完整 RLS、正式消息投递、跨 Run 恢复、多 Agent 调度、供应商运维与模型成本核算仍属上游能力的继续学习范围。

本轮没有新的完整 Supabase、真实客户渠道、正式发送、生产订单履约或真实模型质量验收。适合表述为“基于开源 CRM 的客服履约事实核验二次开发”，不能表述为“独立实现全套 AI CRM 并在生产自动履约”。
