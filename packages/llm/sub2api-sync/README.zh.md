# @deepseek-ai/dsh-sub2api-sync

把一个 [sub2api](https://github.com/Wei-Shaw/sub2api) 实例的分组、密钥、模型同步为 [`dsh-llm-pi-ai`](https://github.com/deepseek-ai/deepseek-harness) 的 provider 路由：登录一次、自动集成、持续同步。

设计 Agent Note：[Phase 1 设计](../../../docs/design/2026-09-04-sub2api-provider-sync.zh.md) 与 [客户端 UI 改造](../../../docs/design/2026-09-30-sub2api-sync-client-ui.zh.md)（当前实现基准）。

## 状态：Mode A（面板驱动）+ 客户端 UI

- **登录通道**：PAT（C1）与 面板密码+2FA（C3）已交付；网页授权（C2，OAuth 授权码 + PKCE）待 sub2api 侧部署后接入；
- **Keys 驱动同步**：Keys 卡列出面板已有 relay key（缺省全不选）→ **勾选多把**（可跨分组）→「同步所选」→ **一把 key 一个供应商**（路由 `sub2api-<key-id>`）→ 模型下一请求即可用；需要新 key 用「创建 key」弹窗（默认与分组同名）；
- **供应商命名**：`providerNameTemplate` 渲染，缺省 `NexaRelay({keyName})`——即 `NexaRelay(<key 名>)`；
- **UI**：设置页顶级卡片（`settings.section`）+ 插件页调参卡（`plugins.bundle.config`），样式对齐 `ui-settings-account`，文案全双语（zh/en）；
- **数据缝**：配置读写走平台 `configForms`（字段级、revision 围栏、schema 校验）；宿主路由只承载动作/秘密/状态投影；
- 指纹路由（旧 Mode B）与分组驱动同步（rev.5）均已退役——同步锚定真实面板 key id。

## 安装

```sh
dsh plugin --profile web add ./packages/llm/sub2api-sync
```

发布后亦可：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-sub2api-sync
```

## 使用

1. 点「登录」，在弹窗里填**实例地址**（如 `https://cn.api.nexarelay.com`，可带 `/v1`）+ 凭据（PAT 或面板邮箱/密码，TOTP 账号按提示输入一次性验证码；密码会存入凭据存储，之后免输入）；
2. **Keys 卡**列出该实例已有的 relay key（最新创建在前，首屏 5 条，底部「加载更多」翻页）。每一行前面的勾选框 = 选中用于同步；右上角「**创建 key**」弹窗可新建：选分组 → 名称默认与分组同名 → 创建即自动勾选；
3. 勾选好要用的 key（可多选、可跨分组），点「**同步所选（N）**」——引擎为**每一把勾选的 key 建一个供应商**，各自发现模型、按所属分组平台映射协议（anthropic → anthropic-messages，OpenAI 家族 → openai-responses，其余 → openai-completions，可按分组覆盖），写入 `llm-pi-ai.providers`；
4. 模型选择器下一请求即可用。主卡下方的「同步」块也能触发一次全量同步并查看完整报告；可选高级参数在 **插件页 → Sub2API Sync** 调参卡。

## 安全

- 一切秘密（面板 token、密码、各 relay key）只进 harness 凭据存储（确定性引用 `DSH_SUB2API_TOKEN_<实例哈希>`、`DSH_SUB2API_KEY_<key-id>`、`DSH_SUB2API_PASSWORD_<实例哈希>`），不进 settings、不进日志、不进会话；
- `GET /keys` 只回 key 元数据（id/名称/分组/状态），**不回明文**；明文只用于引擎解析该 key 并即时写入凭据存储；
- 宿主动作路由只接受回环同源请求；跨设备访问 web UI 时配置只读（平台 `memory` 模式），动作需在 `cordis.yml` 显式开启 `allowRemoteActions`（默认关闭）。

## 同步做什么

对每一把勾选的 key，引擎（幂等 diff + 单飞 + 乐观并发）：

1. 取该 key 的明文（面板列表返回则用之，否则回退凭据存储里已存的 `DSH_SUB2API_KEY_<key-id>`），并保持凭据与面板一致；
2. 携该 key 调 `GET {instance}/v1/models`（失败回退 `modelListOverrides`）；
3. 按**其所属分组**的 `platform` 映射 wire 协议并推导条目 `baseURL`（Anthropic SDK 给裸 host，OpenAI 系给 `/v1` 根）；
4. 经携带 `expectedRevision` 的定点 `settings.mutate` 写入 `providers.sub2api-<key-id>`，附宽松重试策略（5 次 / 120s 退避上限）。

条目只覆盖 `sub2api-<纯数字>` 形态（key id 在面板内唯一，因此**一把 key 一个供应商**，显示名由 `providerNameTemplate` 渲染 key 名）。从勾选集消失的 key 会连带移除条目与凭据；远端 key 仅在 `deleteOrphanKeys` 开启时撤销（路由自带 key id，总是可寻址）。

## Model Experience

- 每分组一个 provider、一把 relay key；模型目录来自实例发现；逐模型 `compat`/`reasoningEfforts` 继承用户模板；
- **模型元数据补全（C4）**：同步时按模型 id 从 models.dev 目录补全 `contextWindow`/`maxTokens`/图片输入——`enrichModelMeta` 开启（缺省）时联网拉取（24h 进程内缓存），失败自动降级到**随包内置快照**（`data/models-dev.snapshot.json`，`pnpm --filter @deepseek-ai/dsh-sub2api-sync models:refresh` 重新生成）；关闭则只用内置快照（离线确定）；两者都未命中的模型保持路由级缺省 128000/8192/纯文本；
- 显示名 = `providerNameTemplate` 渲染的 key 名。

## Known Limitations and Deferred Work

- **面板掩码明文**：若你的面板账号看不到 key 明文（非管理员），同步会失败并提示用管理员账号登录——这是刻意的不静默降级。
- **无 invariant 面**：本包不发布 `./invariant`（同步是一次 settings 写入，可从同一服务读回验证）。
- **网页授权（C2）待 sub2api 侧 OAuth 端点部署**（改造说明见设计 Note §12）；部署前 UI 自动隐藏该通道。
- **dsh 版本下限：0.2.0-rc.2**（客户端半部依赖 `configForms`/locale 服务；0.1.x 代 app 会响亮失败）。
- **客户端半部只允许基线外部模块**（React / Cordis / ui-primitives / ui-slots / client-store / ui-dockkit）——客户端代码不得值导入 `config.ts`（会把 schemastery 拽进浏览器 bundle，动态模块表无此行，加载即静默失败）；`test/client-bundle.test.ts` 是产物守卫。
- 实例前置 Cloudflare 时，需在 zone 放行 `/api/v1/*` 的宿主侧调用（WAF skip 规则）。
- 元数据补全会向 models.dev 发起一次公开目录请求（不带任何凭据与对话内容）；`enrichModelMeta: false` 可完全离线（仅内置快照）。
- 推理档位（`reasoningEfforts`）不由补全自动填充，仅继承 `compatTemplate` 模板。
- 用量查询（`GET /v1/usage`）是已决策的非目标。
- 与社区插件 `GodD6366/dsh-sub2api` 同装：路由名不冲突（本插件 `sub2api-<数字>`），各自管理条目与凭据引用。

## 开发

```sh
pnpm install
pnpm --filter @deepseek-ai/dsh-sub2api-sync typecheck
pnpm --filter @deepseek-ai/dsh-sub2api-sync test
pnpm --filter @deepseek-ai/dsh-sub2api-sync build
```

MIT
