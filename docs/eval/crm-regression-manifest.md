# CRM 回归验收清单

## 标准验证

- `corepack pnpm typecheck`：检查全仓 TypeScript 类型。本机 2026-11-27 验证通过。
- `corepack pnpm portfolio:typecheck`：检查履约扩展与本地演示入口。本机 2026-11-27 验证通过。
- `corepack pnpm portfolio:test`：覆盖履约、事实桥、知识库查询和 Pi runtime 共 12 个测试文件。本机 2026-11-27 结果为 170 项通过、1 项跳过，共 171 项。

## 跨进程验证

| 脚本 | 覆盖内容 |
| --- | --- |
| `scripts/portfolio/browser-smoke.mjs` | 浏览器流程、本地 HTTP、Pi Faux 适配器、页面断言和 15 项声明检查。 |
| `scripts/portfolio/persistence-smoke.py` | HTTP 流程与服务进程重启；结果记录 7 项检查通过。 |
| `scripts/portfolio/live-smoke.py` | 使用已配置的非 Faux 模型运行 2 个请求，核对输出、库存证据与 `sent=false`。 |

跨进程脚本使用根目录 README 描述的本地供应链演示环境。
