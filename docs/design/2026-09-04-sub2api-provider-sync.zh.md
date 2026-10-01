# Agent Note: sub2api 提供方同步插件

Status: proposed

[English](2026-09-04-sub2api-provider-sync.md) | 中文

## 问题

[sub2api](https://github.com/Wei-Shaw/sub2api) 把 Claude、OpenAI、Gemini、Grok 等订阅（现支持 anthropic、openai、gemini、antigravity、grok、kimi、zhipu、deepseek、composite 九种平台分组）聚合为一个 OpenAI/Anthropic 兼容网关，自托管与拼车部署都很常见。今天把它接入本 harness 全靠手工：登录 sub2api 控制台建密钥，回到 Web UI 的 Settings → Models 手动添加 custom provider，逐个录入模型；分组或模型变动后重复整个流程（[providers 指南](../../../../docs/user/guide/providers.zh.md)）。一个实例多个分组的拼车用户重复成本更高。缺少"登录一次、自动集成、持续同步"的通道。

## Proposal

新增单用途插件 `@deepseek-ai/dsh-sub2api-sync`（`packages/llm/sub2api-sync/`，[新包 checklist](../../../../docs/cookbook/adding-a-package.zh.md)）：把一个 sub2api 实例的分组、密钥、模型同步为 [`llm-pi-ai`](../../../../packages/llm/llm-pi-ai/README.zh.md) 的 provider 路由。全部行为走既有扩展点，不改 agent-loop，不改 `llm-pi-ai`。

包内四个组件，不做 capability seam 拆分（单一用途插件，没有可替换角色的第三方消费者）：

| 组件 | 职责 |
|---|---|
| `Sub2apiClient` | 纯 HTTP 客户端，覆盖面板 API 与网关 API；无 DSH 依赖，可独立单测 |
| `SyncEngine` | diff 当前 settings 用户层中本插件的条目与远端分组状态，产出最小写入计划 |
| `CredentialManager` | 经 `ctx.credentials` 存取面板 JWT 与各分组 relay key；settings 只留 credential-ref |
| 表面层 | Settings 卡（配置与触发，[adding-a-settings-card](../../../../docs/cookbook/adding-a-settings-card.zh.md)）+ 模型工具 `sub2api_sync`（[adding-a-tool](../../../../docs/cookbook/adding-a-tool.zh.md)） |

数据流：登录 → `GET /groups/available` → 对选中分组确保一把 relay key → `GET /v1/models` → 计算目标条目 → `ctx.settings.mutate('llm-pi-ai', …)` → 路由在下一个请求即生效（`llm-pi-ai` 的路由集由 settings 驱动、运行时注册）。

### sub2api 面板 API 契约

以下端点逐字核实自 sub2api 源码（`backend/internal/server/router.go`、`routes/auth.go`、`routes/user.go`、`routes/gateway.go`、`handler/auth_handler.go`、`handler/api_key_handler.go`）。面板 API 走 `Authorization: Bearer <access_token>`，网关走 relay key。

| 端点 | 方法 | 契约 |
|---|---|---|
| `/api/v1/auth/login` | POST | `{email, password, turnstile_token?, tencent_captcha_ticket?, tencent_captcha_randstr?}` → `{access_token, refresh_token?, expires_in?, token_type, user}`；账号启用 TOTP 时改返回 `{requires_2fa: true, temp_token, user_email_masked}`（判别字段） |
| `/api/v1/auth/login/2fa` | POST | `{temp_token, totp_code}`（6 位数字）→ 同 login 成功响应；`temp_token` 有时效，过期响亮报错并重走 login |
| `/api/v1/auth/refresh` | POST | `{refresh_token}` → `{access_token, refresh_token, expires_in, token_type}`；实例开启 backend mode 时非管理员被拒 |
| `/api/v1/keys` | GET/POST | 列出/创建 relay key；List 支持 `page`/`page_size`/`sort_by`/`sort_order` 与 `search`/`status`/`group_id` 过滤，响应 `data.items/total/...`；`CreateAPIKeyRequest = {name*, group_id?, custom_key?, ip_whitelist?, ip_blacklist?, quota?, expires_in_days?, rate_limit_5h/1d/7d?}` |
| `/api/v1/keys/:id` | GET/PUT/DELETE | 单 key 读取/更新/删除 |
| `/api/v1/groups/available` | GET | 当前用户可绑定的分组列表，元素含 `id`(int64)/`name`/`platform`/`status`/`rate_multiplier` |
| `/api/v1/groups/rates` | GET | 分组倍率 |
| `{instance}/v1/models` | GET | 网关模型发现（relay key 认证）→ `{"object":"list","data":[…]}`；多数平台元素形如 `{id, display_name, …}`，grok 平台形状不同——客户端只按"取 id、容忍多余字段"读取 |
| `{instance}/v1/chat/completions`、`/v1/messages`、`/v1/responses` | POST | OpenAI / Anthropic / Responses 三种 wire 协议，网关按 key 所属分组平台自动分发 |

面板 API 统一信封：成功 `{code: 0, message: "success", data: <payload>}`，分页端点 `data = {items, total, page, page_size, pages}`；错误携带 `code/message/reason?/metadata?`。`Sub2apiClient` 负责拆包与必需字段校验，缺字段或变形即失败并附实例版本信息。

分组 id 是 int64：取值超出 `Number.MAX_SAFE_INTEGER` 时响亮失败（不静默截断）。

平台全集（`backend/internal/domain/constants.go`）共 9 个：`anthropic`、`openai`、`gemini`、`antigravity`、`grok`、`kimi`、`zhipu`、`deepseek`、`composite`。

### 分组 → provider 条目映射

- provider id 固定 `sub2api-<group-id>`（数字 id 稳定；分组可改名，名字不作标识）。displayName 用分组名。
- `baseURL` 按协议推导（参考实现验证过的拼写）：`openai-completions` / `openai-responses` → `{instance}/v1`；`anthropic-messages` → 裸 `{instance}`（Anthropic SDK 自行追加 `/v1/messages`，给 `/v1` 根会打成 `/v1/v1/messages` 404）。
- `api` 按分组平台映射（`supportedProtocols()` 当前为 `openai-completions`、`openai-responses`、`anthropic-messages`）。映射依据网关源码（`routes/gateway.go`：`isOpenAIResponsesCompatibleGatewayPlatform`）：

  | 分组平台 | `api` 协议 | 依据 |
  |---|---|---|
  | `anthropic` | `anthropic-messages` | 网关 `/v1/messages` 原生转发 |
  | `openai` / `grok` / `kimi` / `zhipu` / `deepseek` | `openai-responses` | 网关对这五个平台经 OpenAI 网关原生转发 Responses API；走原生协议避免 chat/completions 桥接丢并行工具调用 |
  | `gemini` / `antigravity` / `composite` | `openai-completions` | 网关仅提供桥接路径 |
  | 其他/未知平台 | 响亮跳过 | 错误带平台名，不影响其余分组 |

  `protocolOverrides` 可按分组强制覆盖映射。
- 模型列表：优先用该分组 relay key 调 `GET /v1/models`；不可得时回退用户在 Config 里的手填列表。模型元数据（`contextWindow`/`maxTokens`/`reasoningEfforts`/图片输入）在 Phase 2 起，同步时由插件宿主端从 [models.dev](https://models.dev/) 拉取补全（内存缓存 24h；拉取失败只降级为 Config 模板/留空，不算同步失败，`enrichModelMeta` 可关）。模型级 `compat`/`reasoningEfforts` 继承 Config 中的用户模板，使 reasoning 网关的已知差异可预置（如 `supportsDeveloperRole: false`）。
- 每分组一把 relay key，name 约定 `dsh:<provider-id>`；同步时经 `GET /api/v1/keys?search=<name>&group_id=<gid>` 检索 + 客户端精确匹配 name，存在即复用（幂等），不存在才 POST 创建。`quota`、`expires_in_days` 走 Config，缺省不设。复用时若本地凭据缺失，用 List 响应的 `key` 字段回填凭据（仅回填，不进日志/会话）。
- 生成的条目默认携带宽松 `retryPolicy`（`maxRetries: 5`，`retryableCodes` 含 `RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/EMPTY_RESPONSE`，退避上限 120s）——sub2api 是上游限流的代理，llm-pi-ai 默认的 2 次/10s 不足以跨过上游限流窗口。
- 条目归属：只认 `sub2api-<纯数字>` 形态。这是插件写入与清理的范围界线，收紧数字后缀也避免误伤社区插件（GodD6366/dsh-sub2api 写入的 `sub2api-openai` 等路由名）。

### 同步引擎

- 幂等 diff：目标态（远端分组 + key + 模型）对照当前态（settings 用户层 `sub2api-<数字>` 条目 + credentials），产出 `set` / `unset` / noop 最小计划。发射规则：只有同时具备 relay key 与非空模型列表的分组才生成条目——llm-pi-ai 的 hand-declared 路由需要非空 `models`，无 key 路由会暴露为未认证路由。
- 定点写入：`ctx.settings.mutate('llm-pi-ai', ops)` 以路径 `providers.sub2api-<gid>` 只动自己的键；用户手配条目（非 `sub2api-<数字>` 形态）任何情况下不被触碰。`llm-pi-ai` 以 `assertServiceable` 在写入点校验（schema + 可服务性），非法段以 `settings-rejected` 拒绝且整节保持上次有效值——属于响亮失败，不吞。
- 乐观并发：写入带 `expectedRevision`（来自 `describe()`）；`SettingsConflictError` 时重读（并监听 `settings/document-updated` 失效缓存的 revision）、重算、重试（上限 3 次），仍冲突则失败并保留双方状态待人工。
- 单飞：同一时刻至多一个同步在跑；设置卡按钮、`sub2api_sync` 工具、定时器共用一个队列。
- 删除语义：分组从远端消失或被取消勾选 → `unset` 对应 provider 条目 + `unset` 凭据；远端 key 是否撤销由 Config `deleteOrphanKeys`（缺省 false）决定。
- 定时重同步：Config `syncIntervalMs` 可选；仅在挂载了可写 settings provider 时启用，否则跳过并在状态面说明。

### 凭据与安全

- 一切秘密经 `ctx.credentials.set(ref, value)` / `unset(ref)` 落 [`dsh-credentials-local`](../../../../packages/credentials/credentials-local/README.zh.md) 的 `.credentials.yaml`；`settings.yaml` 条目只有 `apiKeyEnv` credential-ref（与用户现有 `SZZZ_API_KEY` 的用法一致）。
- ref 命名确定式：relay key 用 `DSH_SUB2API_KEY_<group-id>`，面板 token 用 `DSH_SUB2API_TOKEN_<instance-hash>`；命名规则进包 README。
- 账号密码只在登录时从 credentials 读出，不进 settings、不进日志、不进会话上下文；错误信息只带 instance 与分组 id。
- 插件的 HTTP 调用是插件自身行为，不注册为模型可用的通用网络工具；模型能触发的只有 `sub2api_sync` 这一个显式动作。

### 登录模式与降级

- Mode A（全自动）：Config 存 instance + email，密码存 credentials；`login` → 响应带 `requires_2fa: true` 时经 `/auth/login/2fa`（`temp_token` + 6 位 TOTP，验证码由用户在设置卡一次性输入、不存储；输错可重输，`temp_token` 过期则重走 login），需要时经 `/auth/refresh` 刷新 access_token。
- 降级触发：实例开启 Turnstile/TCaptcha 时插件不求解验证码——响亮报错并指引 Mode B。
- Mode B（key-first）：用户在设置卡粘贴某分组现成 relay key，跳过面板 API；模型列表走 `GET /v1/models`，生成单分组条目。Phase 1 只交付 Mode B。
- 401：并发请求共享一次单飞 `refresh`，刷新后重试一次；仍 401 则标记登录态失效，等待用户重新登录，不做重试风暴。

### Config

插件自有命名空间定为 `sub2api-sync`——刻意避开 `llm-*` 前缀，使设置卡落在 Web 设置页「插件配置」标签页（`llm-*` 命名空间归模型页所有）；与浏览器半侧卡片以命名空间为键自动配对。自 dsh 0.1.7 起不再有任何注册调用：导出的 `Config` schema 会被自动投影为设置页表单，且每个顶层字段都标记 `volatile`，条目解析后的配置即活数据源——宿主在每次表单写入时就地换入 cell 值（无需重挂载），并经 `loader/volatile-update` 通知，跨字段校验也随之移到这里执行（写入先落盘，无效值改为响亮失败而非在写入点拒收）。

全部字段经校验、可从 cordis.yml 修改（遵循根 [AGENTS.md](../../../../AGENTS.md) 的"插件不硬编码 tunables"规则）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `baseURL` | string（URL 校验） | sub2api 实例地址 |
| `email` | string | 面板账号（Mode A） |
| `enabledGroups` | `number[]` | 分组白名单；缺省同步全部可用分组。分组 id 为 int64，超出 `Number.MAX_SAFE_INTEGER` 的值在写入时被拒绝 |
| `protocolOverrides` | `Record<groupId, 'openai-completions' \| 'openai-responses' \| 'anthropic-messages'>` | 按分组强制指定 pi-ai 协议，覆盖平台默认映射；缺省空 |
| `modelListOverrides` | `Record<groupId, string[]>` | `/v1/models` 不可用时的手填模型 |
| `enrichModelMeta` | boolean（缺省 true，Phase 2） | 是否从 models.dev 自动补全模型元数据 |
| `compatTemplate` | object | 逐模型继承的 compat/reasoningEfforts 模板 |
| `keyQuota` / `keyExpiresInDays` | number? | 自动建 key 的可选限额 |
| `deleteOrphanKeys` | boolean（缺省 false） | 同步移除时是否撤销远端 key |
| `syncIntervalMs` | number? | 定时重同步间隔；缺省关闭 |

单实例形态：多实例需求出现时再升级为列表（无当前证据，不预设）。

### 工具面

`sub2api_sync`（`defineTool`）：参数 `{ groups?: number[] }`，缺省同步全部启用分组；返回结构化摘要（新增/更新/移除的 provider 条目、每分组模型数、错误清单）。描述面向模型："把用户的 sub2api 分组、密钥与模型同步到模型提供方"。

非目标（已决策）：用量查询（`GET /v1/usage`）不纳入——保持单一职责，用量到 sub2api 控制台查看。

### 失败路径

实例不可达、登录被拒、验证码挂起、分组平台无映射、分组 id 超出安全整数、schema 拒绝、revision 冲突、模型发现失败——每条都产出带 instance/分组上下文的可读错误。models.dev 拉取失败是降级而非失败路径。单次 `mutate` 校验整体候选后提交，不落半状态；失败保留上次成功态。

### 测试计划

- 单元：`Sub2apiClient`（注入 fetch + 本地 mock 实例；覆盖信封拆包、`requires_2fa` 判别、分页检索、int64 边界）、平台→协议映射与 `protocolOverrides`、diff 引擎（给定远端态与当前态 → 期望 op 序列）、ref 命名、models.dev 补全（mock 数据 + 失败降级）、`retryPolicy` 透传。
- REAL composition（[testing policy](../../../../docs/testing.zh.md) 要求产品可见插件必须有）：test-only `cordis.yml` 组合 `dsh-settings-file` + `dsh-llm-pi-ai` + 本插件，对本地 mock sub2api server 断言 `settings.yaml` 落盘条目、registry 中路由可达、工具结果。
- HMR/disposal：dispose fiber 后工具、namespace、定时器全部移除，无残留写入。
- 快照：工具结果与设置卡描述（redacted）。

### 实施阶段

1. Phase 1（key-first）：`Sub2apiClient` 网关半部 + 单分组条目生成（含按协议 baseURL 与 `retryPolicy`）+ settings 定点写入 + 最小设置卡。验收 = AC1。
2. Phase 2（全自动）：面板登录/2FA/refresh、确保 key、全分组同步、`protocolOverrides`、models.dev 元数据补全、定时与工具面。验收 = AC2–AC5。
3. Phase 3（可选）：远端 key 撤销、多实例。

## Alternatives considered

1. 维持手配 —— 问题本身否定：重复成本与易错性正是动机。
2. MCP server 形态 —— MCP 只贡献工具，写不了 `llm-pi-ai` provider 配置与凭据，做不到"自动集成"。
3. 独立 CLI 生成 settings 片段供粘贴 —— 无运行时集成、无 UI、易过期。
4. 改 `dsh-llm-pi-ai` 增加 sub2api 原生感知 —— 把一个社区网关的知识塞进通用 adapter，污染 capability seam；provider 配置本就是既有扩展面。
5. 整实例单条目（不分分组）—— 丢失分组隔离（倍率、配额、平台协议各不相同）；分组才是 sub2api 的资源单位。
6. 直接采用现成社区插件 [GodD6366/dsh-sub2api](https://github.com/GodD6366/dsh-sub2api) —— 它解决的是"手动 per-platform 配置的录入体验"：四条固定平台路由（`sub2api-openai` 等）、手贴 key、设置页取模型与识图工具；不做面板登录、分组发现与持续同步，且曾需给 dsh 安装目录打补丁绕过旧版 dsh 的 pi-ai 多轮崩溃（当前 dsh master 已在 `llm-pi-ai` 挂零 usage 修复）。本设计与其目标不同（按分组自动同步 vs 按平台手动录入）；条目归属收紧为 `sub2api-<数字>` 后二者路由名也不冲突，但其实现细节（协议选择、baseURL 拼写、retryPolicy、发射规则）已被本设计吸收。

## Acceptance criteria

1. Mode B：粘贴 key 并选定分组后，`settings.yaml` 出现正确 provider 条目，模型来自该实例，Web UI 模型选择器可选且对话可用。
2. Mode A：email/密码登录后列出分组，勾选即自动建 key（同名复用）并逐分组生成条目；TOTP 账号经一次性输入完成登录；开启验证码的实例明确报错并指引 Mode B。
3. 幂等：连续两次同步，第二次零变更、零新建 key。
4. 收敛：远端新增分组/模型 → 同步后出现；分组移除 → 条目与凭据移除；用户手配条目全程原样；models.dev 补全失败仅降级（条目仍生成，元数据留模板值），不阻塞同步。
5. 并发：与 GUI 同时编辑时 `expectedRevision` 冲突不覆盖他人写入。
6. 响亮失败：每条失败路径有可读错误（含 instance/分组上下文），无静默半状态。
7. 门禁：REAL composition、disposal、单元、快照全绿；[config-catalog](../../../../docs/config-catalog.zh.md) 出现本包配置条目；README 含按契约的 Model Experience 与 Known Limitations；包不发布 `./invariant` 并在 README 说明原因（无可独立分歧的观察关系）。

## Risks

1. 面板 API 无稳定性承诺 —— 最大风险。缓解：必需字段校验、宽容读取、响亮失败；向上游提 issue 争取最小稳定承诺。已知放弃：不支持面板全部能力，只取分组、keys、模型三面。
2. Turnstile/TCaptcha 实例无法全自动登录 —— 已接受的降级（Mode B）。
3. `GET /v1/models` 按平台分组返回有差异（grok 平台元素形状不同、`client_version` 查询切 Codex 清单）—— 已接受：只提取 `id`、失败回退手填列表。
4. relay key 的本机泄露面与现有 provider key 同级（仅 OS 用户可读的 credentials 文件）；不进 settings、日志、会话。List 响应的 `key` 明文仅用于本地凭据缺失时的回填，同样不落日志/会话。
5. "同名复用 key"已核实可行：List 支持 `search`/`group_id` 过滤，`APIKey` DTO 含 `name`（及 `key` 明文）；实现时对真实响应做必需字段校验。
6. 多实例假设未验证 —— Config 已留升级路径，无证据不实现。
7. 与社区插件 GodD6366/dsh-sub2api 同装 —— 二者路由名因 `sub2api-<数字>` 收紧而不冲突；但其 `sub2api-openai` 等路由与本插件写入条目共享 `llm-pi-ai` 命名空间，README 需注明同装时各管各的条目、凭据 ref 不共享。
8. pi-ai 多轮对话的 usage 崩溃已在 dsh master 修复（`llm-pi-ai` replay 为历史 assistant 消息挂零 usage）；README 标注 dsh 版本下限，旧版 dsh 不提供参考实现那种安装目录补丁。
