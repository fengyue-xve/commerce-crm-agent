# AI Agent 升级：实现与复验

本页记录 2026-10-21 代码升级后的独立演示。旧文档中的单步 Faux、内存复核描述是此前版本。完整 CRM 平台、原有 Pi runtime 和数据库权限仍归属上游。

## 可运行闭环

`买家问题 → Pi 最多5轮 → read_stock → 按观察继续 read_replenishment/read_preparation → 收集提议 → 输出护栏 → 最多2轮无工具重写 → 安全草稿/确定性降级 → 循环外提案入库 → 人工执行/核准/补偿`。

默认 Faux 使用真实 Pi SDK 执行脚本化多步调用并消费 Observation，没有外部模型请求。真实引擎支持 OpenAI Responses 和 DeepSeek/OpenAI 兼容 Chat Completions。兼容协议通过实际本地 SSE HTTP 服务与真实 Pi 适配器测试；没有提供真实外部模型 Key，不能宣称已测模型质量、费用或生产效果。

## 模型配置

在启动进程的环境中配置；启动脚本不会自动读取 `.env`。PowerShell 示例：

```powershell
$env:PORTFOLIO_LLM_ENGINE='deepseek' # faux / openai / deepseek / openai-compatible
$env:PORTFOLIO_LLM_API_KEY='<自己的Key>'
$env:PORTFOLIO_LLM_MODEL='deepseek-chat'
# 兼容模式必须指定服务端URL；OpenAI模式默认 https://api.openai.com/v1
$env:PORTFOLIO_LLM_BASE_URL='https://api.deepseek.com'
python scripts/portfolio/demo.py stop
python scripts/portfolio/demo.py start
python scripts/portfolio/live-smoke.py
```

实际 provider 显示于 health 和页面。Key 只在服务端进程使用，不进入页面、提案库或报告。无 Key 时真实引擎启动失败，不悄悄伪装成真实模型。恢复离线模式将 `PORTFOLIO_LLM_ENGINE` 改为 `faux` 后重启。

## 事实与输出护栏

`evidence.ts` 保留 Zod、组织/SKU、采集时间、7天快照时效和部分失败缺口。`output-guardrail.ts` 校验结构化 reply/claims：数量必须来自有效库存/补货事实，不能改写成订单可分配库存、交付承诺或不同计量单位。违规原因连同有效事实进入重写提示，最多2次，仍失败调用确定性安全模板。纠错阶段没有工具，不能追加写入。它是保守的结构与规则检查，不是覆盖所有自然语言表达的语义证明。

## 四级工具与持久提案

| 效果 | 循环内行为 | 循环外行为 |
| --- | --- | --- |
| read | 固定SKU只读，累计校验后的观察 | 展示事实与缺口 |
| reversible_write | 只收集跟进阶段/标签意图 | 人工执行时记录原快照和版本；Undo检查版本并反向写回、版本递增 |
| external | 只收集发送草稿意图 | 草稿复核后人工批准；始终 `canSend=false`、`sent=false` |
| irreversible | 没有执行工具 | 禁用 |

`output/portfolio/agent-state.json` 存储组织隔离的合成商机、草稿、复核、提案、补偿快照与审计；文件锁、原子替换及严格读取校验，损坏时拒绝操作。重启后保留状态。操作以提案revision和商机version检测过期；草稿30分钟后不能新执行/批准，已执行项仍可补偿。重置恢复种子并递增generation，保留审计。它不连接完整CRM的Supabase商机，不具备生产数据库事务或分布式队列能力。

## 复验

```sh
corepack pnpm portfolio:typecheck
corepack pnpm portfolio:test
corepack pnpm exec vitest run tests/unit/pi-runtime-architecture.test.ts
node scripts/portfolio/browser-smoke.mjs
python scripts/portfolio/persistence-smoke.py
```

履约相关150通过/1跳过（包含原82项）、Pi架构17通过；真实页面16项；跨进程重启持久化7组检查。后两项要求供应链18180已启动，且使用Faux。脚本会修改独立合成演示数据。全量上游Windows测试另外审计，不用定向通过替代全仓通过。当前全量状态见 `04-verification.md`。

## Living System Checklist

1. 输入：`SupplyChainReader` 固定路径与reader身份返回真实HTTP观察。
2. 输出：`generateAgentDraft` 将校验后草稿及意图交给 `ProposalStore.recordDraft`。
3. 记录：JSON库保存草稿、复核、execute/undo/approve/reject/reset审计。
4. 界面：`examples/fulfillment-demo/app.js` 渲染事实、护栏、提案、商机版本及审计。
5. 入口：15273工作台的问题输入、生成按钮和顶部重置。
6. 下一步：待复核、待执行/核准、拒绝、过期及冲突状态可见；失败要求重新核对，不自动发送。
7. 配置：`.env.example` / `lib/env.ts` / health；缺Key启动失败；缺事实显示缺口。
8. 连续性：模型交付事实与提案，人执行/拒绝/补偿后可重新核验生成下一版；不宣称模型在线学习。
9. 回路：输出违规触发有原因的重写，持续失败安全降级；版本冲突拒绝覆盖，补偿保留审计。
10. 地图：`docs/architecture/portfolio-fulfillment.architecture.json` 包含输出护栏、持久提案和人工补偿的输入与返回边。
