# 本轮独立场景怎么运行

需要 Node>=22、项目指定pnpm9.15.9、Python3。保留原锁文件；若系统pnpm版本不同，用Corepack按packageManager选择，不要用新版重写lockfile。

```sh
corepack pnpm install --frozen-lockfile
python scripts/portfolio/demo.py start
# 或前台：corepack pnpm portfolio:demo
```

页面 http://127.0.0.1:15273 。停止：`python scripts/portfolio/demo.py stop`。日志和进程记录在被忽略的 `output/portfolio/`。脚本只管理自己创建且PID/创建时间匹配的进程，不停止完整CRM或供应链服务。

## 数据从哪里来

实际读取 [第二项目供应链演示](https://github.com/fengyue-xve/supply-chain-ops-agent)，其Java服务需要启动在127.0.0.1:18180，独立表单服务由它代理读取。第二项目按自己的README准备MySQL和四个服务。读者账号为合成viewer/viewer123，不具备采购写权限。

本仓库 `examples/fulfillment-demo/config.example.json` 只包含合成本机配置。自定义时复制为被忽略的 `config.local.json`，用 `corepack pnpm exec tsx scripts/portfolio/server.mts --config examples/fulfillment-demo/config.local.json` 前台运行；数据库/模型密钥不需要复制进来。适配器只允许本机HTTP源、固定认证和只读工具路径，不接收浏览器传来的URL、组织或token。

仓库独立可安装、专项测试可独立执行；跨项目HTTP演示需要上述供应链服务。服务不可用时仍返回「资料缺失」草稿，不返回模拟成功数据。

## 三分钟展示

1. 选择AUD-001，先用「以当前UTC日期核对时效」执行。2026-09-03固定快照应提示过期，不将18件陈述成当前库存。
2. 改为「固定业务日回放」。实际HTTP仍发生，但明确把同一组合成资料放到2026-09-03评估；页面同时显示真实HTTP取得时间与业务基准日。此时可参考18件和72件补货建议，不能推断客户订单可分配库存或发货日期。
3. 查看同SKU的R-1001准备字段；无论是否已有外箱唛，都要解释没有客户订单关联或物流事实。
4. 展开本次HTTP路径与实际Pi事件。Pi SDK和CRM Pi适配器确实执行，提供器是离线Faux脚本，输出按实际工具观察组装，不是模型质量证明。
5. 勾选核对事项并标记人工复核。该动作仅更新本机临时草稿状态，不发客户消息、不写Supabase。重启会丢失，30分钟过期。

## 验证入口

```sh
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm portfolio:test
corepack pnpm test:unit
# 供应链与本演示启动后，真实浏览器（首次需安装Playwright Chromium）
corepack pnpm exec playwright install chromium
node scripts/portfolio/browser-smoke.mjs
```

专项测试是有意收窄的场景回归，不能替代完整单测、数据库不变量或完整CRM浏览器E2E。完整CRM仍按 `README.upstream.md` 和上游SETUP启动Supabase/worker等；本轮不声称重新验收了完整平台、客户发送、Mem0、WeKnora或Langfuse。

`generateReplyDraft → runAgentPreview` 已有可选服务端运营事实输入，动态事实进入opening并重新校验组织和时效；默认调用行为不变。现有客服界面尚无资料导入控件，公开API也不接受客户端自报来源。这个接口是代码接线，独立页面没有冒充完整CRM页面。

时效按UTC日历日评估，页面明确标出UTC；实际HTTP取得时间保留ISO时间及Z时区，历史回放业务日另列。
