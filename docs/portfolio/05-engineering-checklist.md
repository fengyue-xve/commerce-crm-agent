> 版本说明：下文保留首轮实现记录；真实模型、持久化提案、输出护栏与补偿的当前行为以 [AI Agent升级说明](07-agent-upgrade.md) 为准。

# 工程约束与交付检查

本轮归属：可选业务集成与独立验证基础设施。没有组织启用本场景时，原CRM操作仍完整；未新增生产数据库表、公共API权限或原生页面。可选核心输入是服务端编程接口，默认undefined不改变既有行为。

| 仓库要求的问题 | 本轮具体答案 |
| --- | --- |
| 谁提供输入？ | `SupplyChainReader` 以合成viewer身份查询第二项目固定HTTP接口；手工/服务端输入由 `operationalEvidenceSchema` 和 `assessOperationalEvidence` 校验 |
| 输出给谁？ | `generateOperationalDraft` 的只读工具观察，及 `appendOperationalEvidence` 追加到既有CRM preview opening的可选数据 |
| 实际活动与记录在哪里？ | 原Pi适配器实际发出的事件类型进入DraftResult；HTTP路径/状态进入ReadReceipt；浏览器摘要在忽略提交的 `output/portfolio/browser/summary.json`。复核仅是演示内存状态，不声称有持久审批审计 |
| 在哪里能看见？ | 独立15273页面的事实、未知事项、客户草稿、复核状态和Pi事件；完整CRM原界面未新增导入控件 |
| 入口是什么？ | README中的本地链接与 `scripts/portfolio/demo.py start`。不是新增Next原生页面，因此不虚构NAV_CATALOG入口 |
| 缺资料后如何继续？ | assessment.reasons / readFailures / nextActions在页面可见；核对来源后人工重新执行。演示不负责真实客户需求队列或自动告警，不声称完成无人值守闭环 |
| 配置从哪里看、在哪里改？ | `examples/fulfillment-demo/config.example.json`，自定义config.local被Git忽略。不存在配置UI，不把文件设置说成已持久化CRM组织绑定 |
| AI和人如何交接？ | Pi工具只读，草稿标注未发送；复核按草稿id/revision指向同一记录。商品或时间条件改变即使旧复核上下文失效；没有渠道发送能力 |
| 错误怎样反馈？ | 来源/日期/SKU失败降级可见，修复资料后显式重查；反例和负向控制成为回归。没有自动模型训练、自动修规则或伪造成功 |
| 架构地图在哪里？ | `docs/architecture/portfolio-fulfillment.architecture.json`，实际输入、输出和可选preview消费者均列出 |

组织ID在独立场景中限制该演示进程的作用域，不是生产多系统租户身份映射；范围测试也不替代Supabase RLS测试。没有改schema、RLS、RBAC或生产数据库写入，因此本轮没有冒称执行了数据库不变量验收。

## 证据能证明什么

Faux只控制provider响应，CRM Pi适配器、工具调用和HTTP读取实际执行；证明接线与确定性业务边界。它不证明真实LLM会遵循所有提示、回答准确率或成本。向原CRM opening附加的事实是数据提示，不能代替执行端授权或发送前重校验；正式流程仍沿用上游既有审批机制。

完整Next构建通过只证明编译。合成DB占位不可连接的警告、没有配置真实模型和外部服务、没有本轮Supabase/发送系统端到端测试，都在验证文档保留。
