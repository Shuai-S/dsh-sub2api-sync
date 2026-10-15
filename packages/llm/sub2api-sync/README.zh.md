# @mangoc/dsh-sub2api-sync

把一个 [sub2api](https://github.com/Wei-Shaw/sub2api) 实例的分组、密钥、模型同步为 [`dsh-llm-pi-ai`](https://github.com/deepseek-ai/deepseek-harness) 的 provider 路由：登录一次、自动集成、持续同步。

设计 Agent Note：[Phase 1 设计](../../../docs/design/2026-09-04-sub2api-provider-sync.zh.md) 与 [客户端 UI 改造](../../../docs/design/2026-09-30-sub2api-sync-client-ui.zh.md)（当前实现基准）。

## 状态：Mode A（面板驱动）+ 客户端 UI

- **登录通道**：面板密码+2FA（C3）已交付；网页授权（C2，OAuth 授权码 + PKCE）待 sub2api 侧部署后接入。PAT（C1）已随本插件移除——sub2api 上游从未部署对应端点，该通道无令牌来源；
- **Keys 驱动同步**：Keys 卡列出面板已有 relay key（缺省全不选）→ **勾选多把**（可跨分组）→「同步所选」→ **一把 key 一个供应商**（路由 `sub2api-<10-hex>`，不含顺序 id）→ 模型下一请求即可用；需要新 key 用「创建 key」弹窗（默认与分组同名）；
- **供应商命名**：`providerNameTemplate` 渲染，缺省 `{siteName}({keyName})`——即 `<站点名称>(<key 名>)`，站点名称来自实例探测；
- **UI**：设置页顶级卡片（`settings.section`）+ 插件页调参卡（`plugins.bundle.config`），样式对齐 `ui-settings-account`，文案全双语（zh/en）；
- **数据缝**：配置读写走平台 `configForms`（字段级、revision 围栏、schema 校验）；宿主路由只承载动作/秘密/状态投影；
- 指纹路由（旧 Mode B）与分组驱动同步（rev.5）均已退役——同步锚定真实面板 key id。

## 安装

### 用户安装（发布渠道）

harness 通过包的 `main`/`exports` 入口加载插件，即**构建产物** `lib/index.js`。以下任一渠道装到的 tarball 都自带 `lib/`，无需本地构建：

**npm**——两个包名同步发布：同一份代码、同一版本号，scoped 为 canonical，无 scope 短名为别名，任选其一安装：

```sh
dsh plugin --profile web add @mangoc/dsh-sub2api-sync   # canonical（scoped）
dsh plugin --profile web add dsh-sub2api-sync           # 别名（无 scope 短名）
```

**GitHub Releases tarball**（不依赖 npm；地址始终指向最新版）：

```sh
dsh plugin --profile web add https://github.com/Shuai-S/dsh-sub2api-sync/releases/latest/download/dsh-sub2api-sync.tgz
```

**从源码安装**（pnpm 会对 git 依赖自动执行 `prepare` 构建；需要本机构建链，首次较慢）：

```sh
dsh plugin --profile web add github:Shuai-S/dsh-sub2api-sync#path:packages/llm/sub2api-sync
```

装好后重启应用、或在插件页把开关关掉再打开，让入口重新 import 一次；失败的条目不会自动重试。

### 发布（维护者）

每次发版**双包同步发布**（[scripts/pack-all.mjs](scripts/pack-all.mjs)）：scoped canonical 与无 scope 别名各出一个 tarball，版本号完全一致；客户端 bundle 内嵌的插件名（挂载 key、详情页匹配、ModuleLoader id）与 `cordis.patch.yml` 在打包时按包名注入，两个变体都可独立安装。CI（[.github/workflows/release.yml](../../../.github/workflows/release.yml)）自动完成全流程：bump `packages/llm/sub2api-sync/package.json` 的 `version` → 提交 → `git tag vX.Y.Z && git push origin vX.Y.Z` → `pnpm check` → 双 tarball → npm 双发布（需要仓库 secret `NPM_TOKEN`；`publishConfig.registry` 已锁定 npmjs 官方源，不受 npmmirror 镜像影响）；GitHub Release 附短名 tarball 资产。本地手动双发布：

```sh
pnpm pack:all    # 产出 dist/ 下两个 tarball，仓库文件自动还原
npm publish dist/mangoc-dsh-sub2api-sync-*.tgz --registry=https://registry.npmjs.org --access public
npm publish dist/dsh-sub2api-sync-*.tgz --registry=https://registry.npmjs.org --access public
```

只发 canonical 亦可：`pnpm --filter @mangoc/dsh-sub2api-sync publish`。

### 本地开发（link 调试）

`dsh plugin add` 对本地目录只做软链（`link:`），**不会**为目标目录安装依赖或执行构建，所以先构建是硬性前置条件，而不是「开发时的可选步骤」：

```sh
pnpm install          # 安装依赖（会触发 prepare 构建）
pnpm build            # tsdown + 客户端包装；产出 lib/index.js 与 lib/client.js
dsh plugin --profile web add ./packages/llm/sub2api-sync
```

重新构建后需要重启应用、或在插件页把开关关掉再打开，让入口重新 import 一次；失败的条目不会自动重试。

## 使用

1. 点「登录」，在弹窗里填**实例地址**（如 `https://cn.api.nexarelay.com`，可带 `/v1`）+ 凭据（面板邮箱/密码，TOTP 账号按提示输入一次性验证码；密码会存入凭据存储，之后免输入）；
2. **Keys 卡**列出该实例已有的 relay key（最新创建在前，首屏 5 条，底部「加载更多」翻页）。每一行前面的勾选框 = 选中用于同步；右上角「**创建 key**」弹窗可新建：选分组 → 名称默认与分组同名 → 创建即自动勾选；
3. 勾选好要用的 key（可多选、可跨分组），点「**同步所选（N）**」——引擎为**每一把勾选的 key 建一个供应商**，各自发现模型、按所属分组平台映射协议（anthropic → anthropic-messages，OpenAI 家族 → openai-responses，其余 → openai-completions，可按分组覆盖），写入 `llm-pi-ai.providers`；
4. 模型选择器下一请求即可用。主卡下方的「同步」块也能触发一次全量同步并查看完整报告；报告的每个条目带「**移除**」按钮——只删本地路由与凭据（**不调面板**，余额不足也可用），并自动取消该 key 的勾选，下次同步不会复活；可选高级参数在 **插件页 → Sub2API Sync** 调参卡。

## 安全

- 一切秘密（面板 token、密码、各 relay key）只进 harness 凭据存储（确定性引用 `DSH_SUB2API_TOKEN_<实例哈希>`、`DSH_SUB2API_KEY_<key-id>`、`DSH_SUB2API_PASSWORD_<实例哈希>`），不进 settings、不进日志、不进会话；
- `GET /keys` 只回 key 元数据（id/名称/分组/状态），**不回明文**；明文只用于引擎解析该 key 并即时写入凭据存储；
- 宿主动作路由只接受回环同源请求；跨设备访问 web UI 时配置只读（平台 `memory` 模式），动作需在 `cordis.yml` 显式开启 `allowRemoteActions`（默认关闭）。

## 同步做什么

对每一把勾选的 key，引擎（幂等 diff + 单飞 + 乐观并发）：

1. 取该 key 的明文（面板列表返回则用之，否则回退凭据存储：先读新式 `DSH_SUB2API_KEY_<10-hex>` 引用，再读旧式 `DSH_SUB2API_KEY_<key-id>` 迁移存底，最后尝试 OAuth reveal 接口），并保持凭据与面板一致；
2. 携该 key 调 `GET {instance}/v1/models`（失败回退 `modelListOverrides`）；
3. 按**其所属分组**的 `platform` 映射 wire 协议并推导条目 `baseURL`（Anthropic SDK 给裸 host，OpenAI 系给 `/v1` 根）；
4. 经携带 `expectedRevision` 的定点 `settings.mutate` 写入 `providers.sub2api-<10-hex>`，附宽松重试策略（5 次 / 120s 退避上限）。

路由后缀是 **SHA-256(实例地址, key id) 的 10 位十六进制截断**——稳定、跨实例不碰撞，且**刻意不含面板的顺序 key id**：路由名不暴露站点发过多少 key，截图分享配置也不会泄露。条目只覆盖 `sub2api-<10-hex>`（现行）与 `sub2api-<纯数字>`（旧版遗留，下次同步自动迁移清理）两种形态（**一把 key 一个供应商**，显示名由 `providerNameTemplate` 渲染 key 名）。从勾选集消失的 key 会连带移除条目与凭据；远端 key 仅在 `deleteOrphanKeys` 开启时撤销（key id 由面板 key 列表反查，旧数字路由直接自带）。登出、授权失效与切换实例会**整站清除**本插件的同步状态——owned 路由、relay key 凭据与**上次同步的报告**一并清除（报告描述的状态已不存在，不得继续展示）。

## Model Experience

- 每分组一个 provider、一把 relay key；模型目录来自实例发现；逐模型 `compat` 继承用户模板；推理档位 `reasoningEfforts` 模板显式设置优先，未设置时按模型自动填充（见下）；
- **模型元数据补全（C4）**：同步时按模型 id 从 models.dev 目录补全**显示名称**（`name`，即模型目录编辑器「显示名称」列）/`contextWindow`/`maxTokens`/图片输入/推理档位——`enrichModelMeta` 开启（缺省）时联网拉取（24h 进程内缓存），失败自动降级到**随包内置快照**（`data/models-dev.snapshot.json`，`pnpm --filter @mangoc/dsh-sub2api-sync models:refresh` 重新生成）；关闭则只用内置快照（离线确定）；两者都未命中的模型保持路由级缺省 128000/8192/纯文本；
- **推理档位自动填充**：取 models.dev 条目的 `reasoning_options` 中 `effort` 枚举，映射为 pi-ai 的 `reasoningEfforts`（`none` → `off: null`，其余同名直传）。合并按 **first-party 优先**：官方厂商条目（openai/anthropic/google/zhipuai/zai/deepseek/moonshotai/xai/alibaba 等及官方云托管）存在即胜出——官方条目无 effort 数据（如 claude/gemini 的 budget-only）同样压制聚合商的虚报词表；无官方条目时聚合商来源取**交集**。优先级：**模板显式设置（含 `false`）> 每模型自动填充 > 不写字段**；显示名 = `providerNameTemplate` 渲染的 key 名。
- **显示名称富化**：取 models.dev 条目的 `name` 写入 pi-ai 模型条目的 `name` 字段（模型选择器与「已自定义模型目录」编辑器的显示名）；剥离 models.dev 的 " (latest)" 家族标记，名称与模型 id 相同（无信息量）时不写；合并同样 first-party 优先（官方名称覆盖，聚合商名称仅补缺），纯名称条目也参与富化。

## Known Limitations and Deferred Work

- **面板掩码明文**：若你的面板账号看不到 key 明文（非管理员），同步会失败并提示用管理员账号登录——这是刻意的不静默降级。
- **无 invariant 面**：本包不发布 `./invariant`（同步是一次 settings 写入，可从同一服务读回验证）。
- **网页授权（C2）待 sub2api 侧 OAuth 端点部署**（改造说明见设计 Note §12）；部署前 UI 自动隐藏该通道。
- **dsh 版本下限：0.2.0-rc.2**（客户端半部依赖 `configForms`/locale 服务；0.1.x 代 app 会响亮失败）。
- **客户端半部只允许基线外部模块**（React / Cordis / ui-primitives / ui-slots / client-store / ui-dockkit）——客户端代码不得值导入 `config.ts`（会把 schemastery 拽进浏览器 bundle，动态模块表无此行，加载即静默失败）；`test/client-bundle.test.ts` 是产物守卫。
- 实例前置 Cloudflare 时，需在 zone 放行 `/api/v1/*` 的宿主侧调用（WAF skip 规则）。
- 元数据补全会向 models.dev 发起一次公开目录请求（不带任何凭据与对话内容）；`enrichModelMeta: false` 可完全离线（仅内置快照）。
- 推理档位自动填充只覆盖 models.dev 提供 `effort` 枚举的模型（OpenAI gpt-5 系/o3、GLM 5.x、Qwen3.8、DeepSeek V4 系等）；`toggle`/`budget_tokens` 型推理（claude 系、gemini 系、deepseek-v3.2、kimi-k2.x 等）的线上形态不是 effort 字符串，`reasoningEfforts` 无法表达，仍由模板/`compat` 管辖。
- 用量查询（`GET /v1/usage`）是已决策的非目标。
- 与社区插件 `GodD6366/dsh-sub2api` 同装：路由名不冲突（本插件 `sub2api-<10-hex>` 摘要形态），各自管理条目与凭据引用。

## 开发

```sh
pnpm install
pnpm --filter @mangoc/dsh-sub2api-sync typecheck
pnpm --filter @mangoc/dsh-sub2api-sync test
pnpm --filter @mangoc/dsh-sub2api-sync build
```

MIT
