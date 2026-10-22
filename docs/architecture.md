# Architecture

~~~mermaid
flowchart TB
  Buyer[买家问题] --> Pi[Pi 多步编排]
  Supply[库存 / 补货 / 准备表单] --> Obs[Observation]
  Obs --> Evidence[Zod + 7 天时效]
  Pi --> Guard[输出事实护栏]
  Guard --> SC[最多 2 轮 Self-Correction]
  SC --> Draft[安全回复草稿]
  Pi --> Proposal[ProposalStore]
  Proposal --> Review[人工审批]
  Review --> Exec[执行 / Compensation Undo]
  Exec --> Audit[(Audit log)]
~~~

## Runtime policy

读工具在模型循环内执行；可逆写、外部动作和不可逆动作只生成提案。循环外的执行器校验租户、版本和审批状态，模型无法直接触发外部发送。

## Guardrail policy

Evidence 校验组织和 SKU 范围、时间窗口与部分失败缺口。Output guardrail 检查数字、单位、负号和承诺话术，违规反馈驱动无工具自纠错，超过 2 轮后降级安全草稿。

## Proposal state

提案持久化 generation、原值快照和版本号。reversible_write 支持按当前版本撤销；external 必须人工批准后才可执行，canSend 始终由执行器控制。

## Run and verify

使用根目录 README 的启动命令运行 typecheck、回归、浏览器 smoke 与持久化 smoke。
