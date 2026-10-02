# sub2api-sync 客户端 UI 改造方案（0.2.0 原生适配）

Status: proposed · 2026-09-30（rev.3：叠加双端支持与「像官方一样」网页登录通道设计及 sub2api 上游改造清单；rev.2 已按 0.2.0-rc.2 原生契约适配，废弃 0.1.x 兼容层）

参考背景：`ui-settings-account` 作为「客户端 UI 插件」的实现机制分析。本文把该结论落到本仓库，给出可分阶段落地的改造设计。

事实来源：本仓库源码现状 + DSH 源码 checkout（`/Users/zs/MyCode/deepseek-harness`，tag `dsh-v0.2.0-rc.2`，逐文件核实）。**版本下限：dsh app ≥ 0.2.0-rc.2**——client 半部使用的服务与槽位契约以该代为准，0.1.x 代 app 上会因缺服务响亮失败（见 §10）。

## 0. 结论先行

**现状判定**：本插件已具备客户端 UI 插件骨架——`./client` 导出、`window.__ModuleLoader__` 包装（`scripts/wrap-client.mjs`）、`settings.section` 顶级卡、宿主路由、Mode B 全流程都在运行。真正的缺口是四件事：

1. **数据缝自研过度**：卡片自管 revision、整节 POST `/config`——绕开 0.2.0 的 `configForms` 官方缝，丢了它免费给的东西：schema 客户端校验（schemastery rehydrate）、失败恢复重读、describe 订阅自动刷新、host/memory 持久化模式；
2. **文案硬编码中文**：`label: () => 'Sub2API 同步'`、全部 JSX 文案不随 locale；
3. **手绘 CSS**：~140 行手写样式对照 `--dsw-alias-*` token，未用官方原语库；
4. **Mode A 无 UI**：登录/2FA/分组发现/自动建 key 只有设计文档，无宿主半边亦无界面。

方案 = **U 线（UI 规范化 + 槽位布点，无新宿主逻辑）** 与 **A 线（Mode A：宿主登录半边 + 登录流 UI）** 两条独立推进的改造线，U1/A1 起步互不阻塞。rev.3 叠加三块：**双端支持**（§11）、**网页登录通道**（§5.2/§5.4）、**sub2api 上游改造清单**（§12）。

**可行性结论（先回答）**：可以实现。双端同机（桌面 Electron 与本机浏览器 web）下全功能对等；跨设备 web 访问受平台持久化与回环信任两道平台安全姿态限制，提供只读降级与显式逃生门（§11）。「像官方一样网页登录」需要 sub2api 侧补 OAuth 授权端点（§12 方案 B，**自行改造、不依赖上游**）——官方 DeepSeek 登录的对应机制已逐件核实（§5.4），未部署前以 PAT / 密码+2FA 通道先行（§12 方案 A/现状通道）。「获取分组后直接同步到模型、下一请求即可用」由既有引擎（幂等 diff + 单飞 + 运行时注册）保证，A2 交付勾选即同步的全流。

## 1. 现状与缺口对照

基线：0.2.0 官方客户端插件模式 ↔ 本插件现状。

| 维度 | 0.2.0 官方模式 | 本插件现状 | 缺口 |
|---|---|---|---|
| client 入口 | `Context` 来自 `@deepseek-ai/cordis`；`inject` 导出 cordis 服务名（如 ui-settings-account：`['slots','locale','remote',…,'configForms']`） | `inject: ['slots']`，`ClientContext` 取自已消亡的 `dsh-client-runtime` | 服务面重接（§4.2） |
| 配置读写 | `ctx.configForms.get(ns)`：快照 + 字段级 set/unset + 原子 mutate | 自研 `GET/POST /plugins/.../config` + 卡内 revision | 换官方缝（§7） |
| 调参卡 | 插件自带卡片注册 `plugins.bundle.config`，owner 注入 `form.state`/`form.mutate`（cookbook《live configuration forms》） | 无（依赖 0.1.7 代才有的自动投影） | 新增布点 2 |
| 文案 | `LocaleNamespaceMap` 合并 + `ctx.locale.register(ns,{en,zh})` + `locale:` 槽位拿 `t` | 硬编码中文；label 不随 locale | 全量字典化 |
| 槽位 | `settings.section` + `settings.models.provider-card/footer` + `plugins.detail.*/bundle.config/bundle.activation` | 仅 `settings.section` 常驻 | 增模型页/插件页布点 |
| 样式 | CSS Modules + `--dsw-*` token + ui-primitives | 手写 `<style>` 注入 | 换装 |
| 对话框 | `Modal` + phase 派生（SignIn/SignOut） | 无 | Mode A 引入 |

## 2. 设计原则

1. **一字段一写面**：流程字段（连接/账号/分组/模型选择）归设置页 `settings.section` 主卡，调参字段（协议覆盖/限额/清理策略等）归插件页 `plugins.bundle.config` 调参卡。0.2.0 没有通用投影卡需要隐藏（`rehydrate` 在客户端仅用于 configForms 的 decode 校验，`settings.plugins.tab` 只承载清单类标签页），两个自绘面天然互不重叠。
2. **配置走 `configForms`，动作走宿主路由**：配置读写经 `ctx.configForms.get('sub2api-sync')` 字段级完成；宿主路由只保留「动作 + 秘密 + 状态投影」。秘密纪律不变：key/token 只进 credentials，不回读、不进路由响应；若未来有敏感调参字段进 schema，用 cookbook 的 `role('secret')` 挡在表单响应外。
3. **槽位纪律**：只进官方暴露槽（`settings.section`、`settings.models.provider-card/footer`、`plugins.bundle.config`、`plugins.detail.*`、`plugins.bundle.activation`）；不碰 `root`、不组合 settings shell 内部。`plugins.item` 是官方 namespace 伴侣包的专座（本插件用不到）。
4. **组件全用 `@deepseek-ai/dsh-client-ui-primitives`**：平台模块种子（web shell 静态打包、插件 bundle 基线外置、require shim 解析），peerDeps 声明类型即可；缺失时加载即响亮失败。
5. **构建对齐 cookbook**：`docs/cookbook/adding-a-settings-card.md` 明示树外包自行复刻 `clientBundle` 预设——现有 `wrap-client.mjs` 产物（`__ModuleLoader__.load({id, factory:(require)=>…})` 懒 CJS 闭包）与之同形，保留。

## 3. 槽位布点（全部 0.2.0 已核实存在）

| # | 槽位 | kind | 内容 | 阶段 |
|---|---|---|---|---|
| 1 | `settings.section`（id `sub2api-sync`，order 30；owner `{ close() }`） | list | 主卡：连接、登录（Mode A）、分组管理、同步动作与报告 | 已实现（rev.5） |
| 2 | `plugins.bundle.config`（key= `@deepseek-ai/dsh-sub2api-sync`；owner `PluginConfigViewProps { view:'page', form? }`，bundle 卡只渲染 `page`） | keyed | 调参卡：`protocolOverrides`、`compatTemplate`、`keyQuota`、`keyExpiresInDays`、`deleteOrphanKeys`、`syncIntervalMs`、`enrichModelMeta`；渲染在插件详情页描述与 rows 之间，owner 注入 `form.state` / `form.mutate(ops, expectedRevision)` | 已实现（rev.5） |
| 3 | `settings.models.provider-card`（keyed by `ProviderDirectoryEntry.settingsNs`；owner `{ provider, configured, keyConfigured }`） | keyed | sub2api 路由卡片徽标：`由 Sub2API 同步` Tag + 模型数/上次同步动作 + 管理入口提示（**无跨 section 导航座位**——`openSection` 只在 onboarding/launcher，徽标改为只读 + 路径提示）；源码注释原文即「a plugin distributed outside this repository adds UI to the Models settings section」，且当前**无在册占用者** | 已实现（rev.5） |
| 4 | `settings.models.footer`（owner `{}`） | list | 路由汇总条：`已同步 N 个分组` + 相对时间最近同步（无导航座位，纯状态） | 已实现（rev.5） |
| 5 | `plugins.detail.badge` / `plugins.detail.section`（owner `PluginDetailProps { subject }`） | list | 插件页徽标（同步状态摘要）/ 最近同步报告节；按 `subject.kind === 'bundle' && pkg.name === 本包` 过滤，其余渲染 null | 已实现（rev.5） |
| 6 | `plugins.bundle.activation`（key=包名；owner `{ packageName, onDismiss(), onOpenDetails() }`） | keyed | 启用本插件后的首次引导（贴 key 或登录面板） | 已实现（rev.5） |

布点 3 注册 key= `'llm-pi-ai'`（hand-declared 行共享该 settingsNs），组件内按 `owner.provider` 路由 id 的 `sub2api-<数字>` 前缀过滤——归属判定复用 `isOwnedRoute`。布点 5 的 `subject` 过滤模式即 cookbook §4 的官方示例（`plugins.detail.badge` + `Tag`）。

## 4. 客户端架构

### 4.1 模块结构

```
src/client/
  index.ts              // apply：locale.register + 各槽 slots.inject（薄）
  mount.ts              // 注册逻辑集中（对齐 experimental/client-ui-agent-team 模板）
  locales.ts            // NS='sub2api-sync'；zh 为 key 源，en satisfies Record<Key,string>
  useConfigForm.ts      // configForms 直连：useSyncExternalStore 订阅 + setField/unsetField/mutate 助手
  usePluginApi.ts       // 宿主动作路由 fetch 封装（现 callJson 泛化）
  status.ts             // /status 轮询 → observable source（inject face 的 hooks 间）
  section/
    Sub2apiSyncSection.tsx   // 主卡骨架（四块：连接 / 账号 / 分组 / 同步）
    SignInDialog.tsx         // Mode A（A2）
    GroupList.tsx            // 分组行 + key + 选模型（现 picker 迁入）
  bundleConfig/
    BundleConfigCard.tsx     // 布点 2：调参卡（form.state/form.mutate）
  models/
    ProviderBadge.tsx        // 布点 3
    FooterLink.tsx           // 布点 4
  plugins/
    DetailSections.tsx       // 布点 5/6
  *.module.css               // CSS Modules（替代 ensureCss 手写注入）
```

样板先例：`packages/experimental/client-ui-agent-team/src/client/mount.ts`（`ctx.slots.inject(key, () => ctx.slots.register({...}, Component))` + `ctx.effect(() => ctx.locale.register(NS,{zh,en}))`）。空 `import type {} from '<pkg>/client'` 行用于把 SlotMap/LocaleNamespaceMap 增广与 ctx 服务合并拉进本包编译程序，**必须保留**；本包需要的集合：

- `@deepseek-ai/cordis`（`Context`——0.2.0 已无 `dsh-client-runtime`，该包在客户端各包 package.json 中零引用，`packages/client/runtime` 仅剩构建残留）；
- `@deepseek-ai/dsh-client-locale/client`（locale 服务 + LocaleNamespaceMap）；
- `@deepseek-ai/dsh-client-ui-settings/client`（settings.* 槽位契约 + `configForms` 服务 + `ConfigForm`/`ConfigFormSnapshot` 类型）；
- `@deepseek-ai/dsh-client-ui-renderer/client`（`ctx.slots` 服务类型，0.2.0 起槽位 Service 层在此）；
- U2 追加：`@deepseek-ai/dsh-client-ui-settings-models/client`、`@deepseek-ai/dsh-client-ui-plugin-manager/client`（扩展槽契约）。

### 4.2 locale 化与服务注入

- client 入口导出 `inject = ['slots', 'locale', 'configForms']`（cordis 服务名——真正的服务缝）；`package.json` 的 `dsh.client.inject` 是**信息性包名边**（装配图/加载顺序），不注入服务——两者勿混。
- `declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'sub2api-sync': Sub2apiSyncKey } }`；`ctx.effect(() => ctx.locale.register(NS, { zh, en }), '…: dictionaries')`。
- 每个槽位注册带 `locale: NS`，组件 props 获得框架合成的 `t`；列表槽 `label: () => t('nav')`（thunk 随 locale 切换重估，无需重注册）。
- 编译期双语平衡：`zh` 定 key 集，`en satisfies Record<Sub2apiSyncKey, string>`；另补一条 vitest 断言双字典 key 集相等（树外不受 dsh 的 `verify-client-ui-i18n` AST 门禁覆盖，以测试替代）。
- locale / configForms 都是 app 客户端组合的常驻官方插件（语言切换、设置缝即其所出）；缺服务时 boot 响亮失败并列出未激活条目，符合平台哲学，不做软降级。

### 4.3 原语换装对照

| 现状（手写） | 换成 |
|---|---|
| `.s2s_button`（primary/bordered/danger） | `Button`（`primary/outline/ghost` variant） |
| `.s2s_input` / `.s2s_select` | `Input`；下拉用 `Menu`+`MenuSurface`（原语库无 Select）或 `SegmentedControl` |
| `.s2s_tag` / `.s2s_tagOk` / `.s2s_tagWarn` | `Tag`（TagTone）/ `StateDot`（idle/ongoing/done/error） |
| 「同步中…」文本 | `StateDot` ongoing + `TextShimmer` |
| 新分组表单行 | `ConfigField` |
| notice/error 行 | `Toast`（actions 带重试） |
| 模型选择面板 | `Modal` + `Input` 搜索 + `Checkbox` 列表 |
| 手写 `<style>` 注入 `ensureCss()` | CSS Modules（构建链按包编译、hash 类名、`data-plugin` 注入——模板已验证可行） |

### 4.4 视觉规格：对齐 ui-settings-account

逐项取自 `AccountSection.module.css`（218 行样式即布局语言），主卡与对话框全部照此规格实现，不再自创几何：

| 元素 | 规格（AccountSection 原值） |
|---|---|
| 页根 `.section` | flex column，gap 16px，padding 8px 0，字号 13px/行高 22px，`--dsw-alias-label-primary` |
| 卡片 `.card` | padding 12px 16px，边 0.5px `--dsw-alias-settings-card-stroke`，圆角 `--dsw-radius-xl`，底 `--dsw-alias-settings-card-fill` |
| 行 `.row` | min-height 40px，padding 6px 0，space-between，gap 16px |
| identity 行 | min-height 44px；32×32 圆形图位（分组用平台首字母/icon，底 `--dsw-alias-bg-skeleton`）+ 两行文案（名称 14px/500，次级 tertiary） |
| 次级文案/状态 | `--dsw-alias-label-tertiary` |
| 分隔线 | 0.5px `--dsw-alias-border-l2` |
| 动作区 `.actions` | flex-end，gap 10px，可换行；按钮 36px 高 / min-width 58px / `--dsw-radius-md` |
| 焦点 | `--dsw-focus-ring-width/color` outline + offset 2px（primitives 自带则用自带） |
| 顶部 identity | 复刻账户卡头部：圆位（登录态用 `StateDot` 着色）+「sub2api · <实例域名>」+ 登录态次级行，右侧动作区 |
| 对话框 | `Modal` + phase 派生（SignInDialog 同构：initializing/waiting/exchanging/committing/expired/failed） |

组件结构同时照抄其工程模式：props = `PropsRuntime & PropsLocale & InjectFace`，数据经 `hooks` 间选择器 hook（`useStatus`/`useConfigForm`）进入组件，组件保持 Cordis-free。

## 5. Mode A：登录流与状态机

### 5.1 宿主半边（A1，UI 的前置）

- `Sub2apiClient` 补面板半部（设计 Note 已定契约）：`login`（`requires_2fa` 判别）、`login/2fa`、`refresh`、`groups/available`、`keys`（检索/创建）。
- access/refresh token 存 `DSH_SUB2API_TOKEN_<instance-hash>`（`panelTokenRef` 已预留）；TOTP 一次性输入不落盘。
- 引擎 target 解析扩展：`enabledGroups ∩ 远端分组`（面板发现）∪ 现有 `manualGroups`（Mode B），两组来源同一条幂等写路径。**一个分组 = 一个供应商**（路由 `sub2api-<gid>`，不变）。**每分组一把 key，来源三态**（Config `manualGroups[gid].keyId?: number`，缺省 = 自动）：
  - **自动建 key**（缺省）：新 key 名 = **分组名**（console 里一眼可辨归属）。未存 keyId 时按「该分组内 key 名 = 组名」精确匹配检索复用，缺则创建并**持久化返回的 keyId** → 此后幂等按 keyId 复用，分组改名不漂移（本节取代原设计 Note 的 `dsh:<provider-id>` 命名约定——幂等性改由 keyId 承担，名字只作 console 辨识）；
  - **已有 key**（`keyId` = 面板 key id）：List 按 id 精确检索 → 取响应 `key` 明文 → **仅凭据缺失时**回填 `DSH_SUB2API_KEY_<gid>`（回填语义原设计 Note 风险 5 已背书；凭据已在则不重复拉明文，最小暴露面）→ 该分组条目直接用这把 key，不建新 key。keyId 持久化进 config，重同步幂等不换 key；
  - **粘贴**（key 来源第三态）：登录态下粘贴明文 key 直接写凭据、keyId 留空——key 归属跟随所选分组的真实 gid（路由 `sub2api-<gid>`）。**指纹路由族整体退役**（rev.4，未上线无历史包袱）：原「无登录先粘贴 key」的 Mode B 删除，`fingerprintKeyId` 不再派生路由；面板不可达的场景由自部署 PAT 覆盖。
  - 已有 key 被面板侧吊销 → 401/模型发现失败响亮，卡片提示换选另一把或回「自动」。
- **供应商命名**：displayName = Config 新字段 `providerNameTemplate`（模板字符串，`{keyName}` 占位符）渲染，**缺省 `NexaRelay({keyName})`**——自动建 key 时即 `NexaRelay(<分组名>)`，选已有 key 时为 `NexaRelay(<该 key 名>)`。模板入 Config 而非硬编码（遵循「插件不硬编码 tunables」），归调参卡管辖（§6）。
**面板契约实测（2026-09-30，真实实例 cn.api.nexarelay.com，实现以此为准）**：

```
GET /api/v1/keys?page=&page_size=          →  {code:0, message, data:{ items:[{
  id:int, user_id:int, key:"sk-…"(明文), name:"新站点-agent"(中文可),
  group_id:int, status:"active", ip_whitelist/blacklist, last_used_at/ip,
  quota, quota_used, expires_at, current_concurrency, rate_limit_5h/1d/7d,
  usage_5h/1d/7d, window_*_start, created_at/updated_at,
  group:{ …完整分组对象… } }], total, page, page_size, pages }}

GET /api/v1/groups/available               →  {code:0, message, data:[{   ← 裸数组，非分页信封
  id:int, name, description, platform,                        ← 平台直读（Mode A 无需推断）
  rate_multiplier, is_exclusive, status:"active", subscription_type,
  daily/weekly/monthly_limit_usd, allow_image_generation, claude_code_only,
  allow_messages_dispatch, require_oauth_only, rpm_limit, max_reasoning_effort,
  reasoning_effort_mappings, created_at/updated_at, …fork 字段超集… }]}
```

读取纪律：只取已知字段、多余忽略；`platform` 直读（`guessPlatformFromModels` 降级为粘贴路径专用）；分组行 Tag 用 `platform/rate_multiplier/status`（+`claude_code_only`/`is_exclusive` 展示性标注）；`status` 过滤按 `==='active'` 起步，未知值响亮列出。

- 新路由（全部延续 `trustedRequest`；跨设备 web 见 §11 逃生门）：

| 路由 | 方法 | 语义 |
|---|---|---|
| `/plugins/.../login` | POST | `{email}`；密码从 credentials 读取（不在请求体）；答 `{requires2FA}` 或 `{signedIn}` |
| `/plugins/.../login/2fa` | POST | `{code}` 一次性；`temp_token` 过期响亮报错 |
| `/plugins/.../logout` | POST | 清 token 凭据 |
| `/plugins/.../groups` | GET | 登录态下面板分组（id/name/platform/status/rate_multiplier）+ 当前启用标记 |
| `/plugins/.../group-keys` | GET | `?groupId=` → 面板 `GET /api/v1/keys?group_id=` 拆包；返回 `{id, name, status, expired_at}` 列表——**不含 key 明文**（明文只在引擎解析该 keyId 且凭据缺失时宿主侧拉取回填） |
| `/plugins/.../pat` | POST | `{token}` 首次粘贴 PAT（方案 A）→ 校验（调一次 `GET /groups/available`）→ 存 credentials |
| `/plugins/.../oauth/start` | POST | 发起授权码流（方案 B）：生成 `state`、组装 sub2api authorize URL、记录 attempt；答 `{authorizeUrl}` |
| `/plugins/.../oauth/callback` | GET | sub2api 授权回调（浏览器 redirect 落点）：校验 `state` → 宿主用 `code` 换 token → 存 credentials → 302 回 web UI。**信任模型 = state 一次性校验（OAuth 标准实践），不走 `trustedRequest`**：redirect 来自 sub2api 域（sec-fetch-site: cross-site、远程 peer），按回环/同源校验会把跨设备 web 的授权流直接 403 掐断——callback 是唯一豁免网络位置检查的路由，防 CSRF 由 state（绑定 attempt、短时效、一次性）承担 |
| `/plugins/.../oauth/status` | GET | 当前 attempt 状态（waiting/exchanging/signedIn/failed/expired），对话框 phase 派生用 |

- **状态不新增 volatile Config 字段**：登录态由 token 凭据可用性 + 401 响亮失效派生；`lastReport` 留宿主内存（现状）。这刻意区别于 ui-settings-account 的 onboarding 状态机——那是纯设备本地的 UX 进度，而登录态有事实源（token），持久化只会制造第二事实源。宿主半部的 `Config` volatile + `loader/volatile-update` 模式保持不变（cookbook §1 即官方写法）。
- `sub2api_sync` 工具、定时器、设置卡共用引擎单飞队列（现状已保证）。

### 5.2 登录通道矩阵与客户端流（A2/A3）

三条通道共用同一登录态与后续流，UI 上以 SegmentedControl 呈现，按可用性自动推荐：

| 通道 | 依赖 | Turnstile/TCaptcha 实例 | 双端 | 阶段 |
|---|---|---|---|---|
| **C1 PAT 粘贴**（`POST /pat`） | sub2api 方案 A（PAT，§12） | ✅ 天然绕过 | ✅✅ | A2 |
| **C2 网页授权**（`POST /oauth/start` → 浏览器 → `GET /oauth/callback`） | sub2api 方案 B（OAuth，§12） | ✅ 用户在真实登录页自己过 | ✅✅（像官方一样） | A3 |
| **C3 密码 + 2FA**（`POST /login[/2fa]`） | 无上游改动 | ❌ 响亮报错指引 C1 | ✅✅ | A2 |

C2 客户端流（对照官方 `SignInDialog` 的 phase 派生）：

1. 主卡「账号」块选「网页登录」→ `POST /oauth/start` → 答 `authorizeUrl`；
2. 卡片立即切 waiting phase，`window.open(authorizeUrl, '_blank', 'noopener')` 打开 sub2api 真实登录页（桌面端打开的是用户默认浏览器，Electron 外链语义与官方一致；提供 copy-link 兜底——官方同款）；
3. 用户在 sub2api 页面完成登录（验证码/2FA 都在该页自然完成）并点击「授权 DeepSeek Harness 同步分组」consent；
4. sub2api 302 redirect 到 `{harness origin}/plugins/dsh-sub2api-sync/oauth/callback?code&state`——宿主校验 `state`（attempt 绑定，一次性）→ 服务端 `code` 换 token 对 → 存 credentials → 302 回 web UI（卡片经 `/oauth/status` 轮询转 signedIn，或漂回前台后状态自愈）；
5. 成功 → 「分组」块切换为**分组列表**（每分组一行，视觉见 §4.4）：行内 = 勾选框（**缺省全不选**，写 `enabledGroups`）+ 平台/倍率 Tag + **key 来源控件**（SegmentedControl 或 Menu）+ **供应商名预览**（自动 → `NexaRelay(<组名>)`；选已有 → `NexaRelay(<key 名>)`，随模板）：
   - **自动**（缺省）：勾选即同步，引擎建/复用名为**分组名**的 key——「勾选分组自动创建 key 再同步」；
   - **选已有 key…**：展开 `GET /group-keys` 列表（name/status Tag）单选一把 → `keyId` 写 `manualGroups[gid]` → 同步直接用这把 key——「已有 key 勾选即用，不建新 key」；
   - **粘贴**：Mode B 退化路径（无面板登录时）。
   勾选集 + key 来源经 `form.set` 字段级写（`enabledGroups` / `manualGroups`），组名/平台回填 `manualGroups`；
6. 「立即同步」→ 引擎按各行 key 来源解析（自动：建/复用名为**分组名**的 key；已有：用勾选的那把）+ 全分组写条目（displayName 按 `providerNameTemplate` 渲染）→ `llm-pi-ai` 运行时注册，模型选择器下一请求即可用 → 报告视图（沿用现 report 渲染）；
7. 登出 → `SignOutDialog` 语义：同步进行中时提示中断风险。

C1/C3 的差异只在第 1–2 步（PAT 粘贴 + 一次校验调用；或 email/password + 可选 TOTP 步），第 3 步起完全同流。

### 5.3 状态共享

`/status` 轮询收敛为一个 observable source，经 inject face 的 `hooks` 间声明（对齐 `AccountSectionInjected.hooks.account` 模式）→ 组件侧合成 `useStatus` 选择器 hook。主卡、模型页徽标（布点 3）、插件页 badge（布点 5）共用同源，轮询频率单处可调。OAuth attempt 状态走 `/oauth/status` 同一轮询框架。

### 5.4 与官方 DeepSeek 登录的机制对照

官方机制逐件核实自 checkout（OAuth 客户端本体在私有包 `dsh-deepseek-account`，本 checkout 无源码；消费侧证据：`packages/api/account-controller/src/index.ts:66`、`ui-settings-account/src/client/index.ts`）：

| 环节 | 官方 DeepSeek 登录 | 本插件 C2 对应物 |
|---|---|---|
| 发起 | `ctx.remote.account.startSignIn(client, callbackOrigin, loginSource: 'web'\|'desktop')` → 返回 authorize URL | `POST /plugins/.../oauth/start` → 宿主组装 sub2api authorize URL（`response_type=code`、`client_id`、`redirect_uri`、`state`、PKCE） |
| 打开浏览器 | `window.open` + copy-link 兜底 | 同款（`authorizeUrlWithTheme` 的主题参数可选借用） |
| 等待期 UI | `SignInDialog` phase：initializing/waiting/exchanging/committing/expired/failed | `SignInDialog` 同 phase 集，源换 `/oauth/status` |
| 回调落点 | harness 持有的浏览器可达 loopback HTTP origin（`callbackOrigin`） | 插件自有 webServer 路由 `/plugins/dsh-sub2api-sync/oauth/callback`（exact 注册，回环与 web 同源皆可达） |
| 令牌交换 | 宿主侧 `dsh-deepseek-account`（平台 code→token） | 宿主侧对 sub2api `POST /api/v1/oauth/token`（PKCE verifier + code） |
| 凭据归宿 | 系统凭据域 | `DSH_SUB2API_TOKEN_<instance-hash>`（credentials，不进 settings/日志） |
| 状态推送 | `ctx.remote.$stream<AccountView>`（`account.watch`） | `/oauth/status` + `/status` 轮询（不引入新推送通道，见 §13 非目标） |
| 2FA/验证码 | 平台登录页内完成 | sub2api 登录页内完成（这正是 C2 对 Turnstile 实例的解） |

差异点只有一个，也是 §12 存在的理由：官方 IdP（DeepSeek 开放平台）天然有 OAuth 授权端点，sub2api 目前没有——需要上游补。

## 6. 字段分治（两个自绘面，零交集）

| 字段 | 写面 |
|---|---|
| `baseURL`、`email` | 主卡（settings.section） |
| `manualGroups`、`enabledGroups` | 主卡（增删/勾选流） |
| `modelListOverrides` | 主卡模型选择器（兜底手填走 yaml 直编，README 注明） |
| `protocolOverrides`、`compatTemplate`、`providerNameTemplate`（缺省 `NexaRelay({keyName})`）、`keyQuota`、`keyExpiresInDays`、`deleteOrphanKeys`、`syncIntervalMs`、`enrichModelMeta` | 调参卡（plugins.bundle.config） |
| 主卡 | 不再整节 POST；全部经 `useConfigForm` 字段级写 |

两卡读同一 `configForms.get('sub2api-sync')`（同一 describe 镜像派生，永不互相看到过期值），写各自管辖区。过渡期（U1 前）在 README 标注「分组管理请用 Sub2API 同步页」。

## 7. 数据缝：`configForms` 直连（0.2.0 原生）

服务面（核实自 `packages/client/ui-settings/src/client/config-form.ts` 与 `config-form-types.ts`）：

```ts
const form = ctx.configForms.get<Sub2apiSyncConfig>('sub2api-sync')
form.getSnapshot()   // { status: 'loading'|'ready'|'unavailable', value, base, user, revision, writable, mode }
form.subscribe(fn)   // 快照替换通知（useSyncExternalStore 配对）
form.set(field, value)      // 字段级写，自动携带最新 revision，仅最新落定发布
form.unset(field)           // 清字段 → 回落组合层
form.mutate(ops, expectedRevision?)  // 原子多字段写（SettingsPathOpView[]）
```

免费获得：schemastery rehydrate + validate 的客户端 decode（schema 变形即 `unavailable`，不渲染脏数据）、失败最新写自动重读恢复、describe 订阅自动刷新（`settings/document-updated`、`connection/reset` 由 ui-settings 统一管）、host/memory 持久化模式判定。

改动清单：删除 `ROUTES.config` 两条路由与 `RouteDeps.getConfig/setConfig/revision`（`sync` 后的报告仍走 `/status`）；主卡删除自管 `revision`/`postConfig`/`withSection` 整节逻辑，改 `useConfigForm`。

**传输缝备注**：同源 `fetch` 到 `webServer.register` 路由是被官方先例背书的合法静态插件缝（open-in-app 即此模式）；`/plugins/dsh-sub2api-sync/*` 的 exact 路由与 client-modules 声明的 `/plugins` 前缀路由共存（exact 优先、longest-prefix 次之，现卡已实证可用）。中期可选升级为自有 **Remote namespace**（typed RPC，经 `/api/remote.mux` WebSocket 多路复用）——非本方案范围，`usePluginApi.ts` 单文件封装使该迁移只动一处。

## 8. 构建与依赖（全部对齐 0.2.0-rc.2）

- **删除** `@deepseek-ai/dsh-client-runtime`（0.2.0 已消亡）：`Context` 改从 `@deepseek-ai/cordis` 导入；
- peerDeps：`@deepseek-ai/cordis`、`react`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-client-ui-settings`（类型来源）；
- devDeps 全部升 `0.2.0-rc.2`（cordis 4.0.4 不动；注意 `pnpm-workspace.yaml` 的 rc 归一化特例在 0.2.0 线会复现——`^0.2.0-rc.2` 被 pnpm 11 归一化为 `>=0.2.0 <0.3.0-0` 排除唯一存在的 rc，overrides 需逐包钉 `0.2.0-rc.2`）；
- `dsh.client`：`{ platform: 'web', inject: ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-settings'] }`（信息性包名边）；`./client` 导出与懒 CJS 包装不变（cookbook §5 明示树外包自行复刻 `clientBundle`）；
- CSS Modules 由构建链编入 bundle（`css-modules.d.ts` 声明，模板先例）。

## 9. 实施阶段与验收

**U0 依赖与骨架升级**：devDeps 升 0.2.0-rc.2、删 dsh-client-runtime、服务注入面改 `['slots','locale','configForms']`、空 import type 集合重接。
验收：`typecheck` 全绿（0.2.0 契约下）；app ≥ 0.2.0 上现卡功能不回归。

**U1 规范化**：locale 化 + 原语换装 + CSS Modules + `configForms` 直连（删 `/config` 路由）+ 布点 2 调参卡 + 字段分治。
验收：双语切换全卡生效；主卡/调参卡字段零交集且读同一快照；密钥不回读纪律不回退。

**A1 宿主 Mode A**：panel client + 登录/2FA/logout/groups/group-keys 路由 + 引擎 keySource 三态解析/面板 targets + 定时器（`syncIntervalMs`）。
验收：设计 Note AC2（Mode A 登录、2FA、自动建 key、验证码实例响亮降级）+ 新命名规则：**自动建 key 名 = 分组名**且 keyId 持久化（分组改名后重同步不新建 key）；**供应商 displayName = `NexaRelay(<key 名>)`**（模板渲染，选已有 key 时跟随该 key 名）；一分组恰一供应商条目。

**U2 槽位布点**：布点 3–6（0.2.0 契约全部已核实存在，无需安装版验证；前提仅是 app ≥ 0.2.0-rc.2）。
验收：模型页 sub2api 路由卡出现管理徽标并可跳转；插件页出现状态徽标与报告节。

**A2 客户端 Mode A UI（C1 + C3 通道）**：SignInDialog/2FA/PAT 粘贴/分组列表（勾选自动建 key + 已有 key 选择）/SignOutDialog + `useStatus` 共享源。
验收：PAT 或密码登录 → 勾选分组（自动建 key）同步全流不出设置面板；**勾选已有 key 的分组零新建 key**（远端 key 数不变）；登出有进行中提示；模型选择器下一请求可用；视觉与 ui-settings-account 卡片并排无违和（§4.4 规格）。

**A3 网页授权（C2 通道）**：`/oauth/start|callback|status` 三路由 + PKCE + state 一次性 + copy-link 兜底。前置 = 自部署完成 §12 方案 B；未部署时 UI 隐藏该通道入口（能力探测：`GET {instance}/api/v1/oauth/.well-known` 或 authorize 端点探活）。
验收：Turnstile/TCaptcha 实例经真实登录页完成授权；桌面与 web 同一流；过期/取消/复用 code 均响亮。

**U3 打磨**：Toast/StateDot 全局反馈、报告可视化、双语字典补全、README 版本下限标注、**非回环 web 降级提示**（`form.writable === false` → 卡片顶部警示条「当前页面进程本地，配置仅本页生效」）+ `allowRemoteActions` 逃生门（§11）。

**测试基线**（贯穿各阶段，承接原设计 Note 测试计划）：单元（面板 client mock 实例、keySource 三态矩阵、模板渲染、命名/凭据漂移矩阵）+ REAL composition（test-only cordis.yml 组合 `dsh-settings-file` + `dsh-llm-pi-ai` + 本插件，对本地 mock sub2api server 断言落盘条目与路由可达）+ disposal（fiber 卸载无残留）+ REAL 冒烟（对真实实例验证 §14-A 契约）。

## 14. 待确认清单（Open Questions）

### A. 事实核验（2026-09-30 真实实例实测，部分落定）

| # | 状态 | 结论 |
|---|---|---|
| A1 | ✅ **落定** | keys List `data.items[]` 含：`key` **明文**、`group_id`、`name`（**中文可用**，实测「新站点-agent」）、`status`、`quota/quota_used`、`expires_at`、`rate_limit_5h/1d/7d`、`current_concurrency`，且**嵌套完整 `group` 对象**——「选已有 key」回填与 `/group-keys` 路由成立 |
| A2 | 🔶 大半落定 | 读取侧 `name` 中文实测存在；**创建侧**（以组名 POST `/keys`）待 A1 阶段首跑验证 |
| A3 | 🔶 大半落定 | `status:"active"` 实测（全部 18 个可见分组均 active）；其余取值域未见——引擎过滤先按 `status==='active'` 起步，未知值响亮列出 |
| A4 | ⬜ 待验证 | Turnstile/TCaptcha 实例错误契约（可判别 code vs 泛 403）——翻 fork 源码 `handler/auth_handler.go` 或带错误码实测 |
| A5 | ⬜ 待验证 | access/refresh token TTL 实际时长——翻 fork 源码 JWT 签发处 |
| A6 | ⬜ 待验证 | 面板 API 速率限制——翻 fork 中间件 |

**实测带来的契约修正与简化**（详见 §5.1「面板契约实测」）：

- **信封修正**：keys List 是分页信封（`data:{items,total,page,page_size,pages}`，实测 total 27/pages 2），但 **groups/available 的 `data` 是裸数组**——原设计 Note「分页端点 data={items,…}」只对真分页端点成立；`Sub2apiClient` 拆包按端点区分；
- **Mode A 平台直读**：分组 DTO 直接携带 `platform`（实测出现 `openai/anthropic/gemini/deepseek/zhipu/kimi/grok`，与平台集合吻合）——Mode A 不再需要 `guessPlatformFromModels` 推断（该函数降级为粘贴路径专用）；
- **key DTO 嵌套 `group` 全量对象**——「选已有 key」UI 直接显示组名/倍率，无需二次查询；
- **fork 字段超集**：实例 DTO 含大量 fork 新增字段（`claude_code_only`、`is_exclusive`、`reasoning_effort_mappings`、`require_oauth_only`、`allow_messages_dispatch`…）——客户端维持「只取已知字段、多余忽略」的容忍读取纪律，其中 `claude_code_only`/`is_exclusive` 以 Tag 展示在分组行（不阻断同步）；
- 分组行 UI 可用字段实测确认：`name/description/platform/rate_multiplier/status`。

### B. 环境待确认

| # | 事项 | 说明 |
|---|---|---|
| B1 | **目标 dsh app 版本 ≥ 0.2.0-rc.2** | rev.2 起方案原生对齐 0.2.0；若实际 app 是 0.1.7 代，U0 前需先升级 app（client 半部在 0.1.x 会响亮失败） |
| B2 | 同机桌面 + web 是否共享 `$DSH_HOME` | 共享则双端操作同一份 settings/凭据（后写赢）；文档需注明并发编辑语义（revision 围栏已兜底） |
| B3 | ~~console 认证形态~~ **已核实（curl）**：localStorage Bearer 头 → SPA consent 方案锁定 | Cookie 会话分支作废 |
| B4 | **CF 放行规则**（实例前置 Cloudflare）：`/api/v1/*` Skip 托管质询 | 宿主侧调用（token 换发/同步/模型发现）不被质询的前提，见 §12-0 |

### C. 产品决策（已于 rev.4 拍板）

| # | 决策 | 结论 |
|---|---|---|
| C1 | Mode B（指纹路由）迁移语义 | **未上线、不兼容历史数据 → 指纹路由族整体退役**：`fingerprintKeyId` 路由命名删除；「粘贴」降为登录态下的 key 来源第三态（key 归属跟随所选分组 gid）。原 `manualGroups` 语义可自由重构 |
| C2 | 分组勾选缺省态 | **全不选**（用户逐组勾选，避免误同步全部分组） |
| C3 | `sub2api_sync` 工具面 | 保留：仅同步动作，参数 `{ groups? }`；不可触发登录/写凭据 |
| C4 | models.dev 元数据补全 | **已实现（rev.5）**：引擎同步时按模型 id 从 models.dev 补全 contextWindow/maxTokens/图片输入；联网拉取 24h 缓存，失败与关闭态降级到随包内置快照 `data/models-dev.snapshot.json`（`models:refresh` 脚本再生成）；~~`reasoningEfforts` 仍仅由模板控制~~ **rev.6 起按模型自动填充**：取条目 `reasoning_options` 的 `effort` 枚举映射为 pi-ai 档位（`none`→`off: null`，其余同名直传），合并 first-party 优先（官方条目存在即胜出、budget-only 亦压制聚合商虚报；无官方条目时聚合商取交集），优先级 **模板显式设置（含 `false`）> 每模型自动填充 > 不写**，仍由 `enrichModelMeta` 管辖；`toggle`/`budget_tokens` 型推理（claude/gemini/deepseek-v3.2/kimi-k2.x）无 effort 字符串线形态，不适用 |
| C5 | `providerNameTemplate` 校验 | 必须含 `{keyName}` 占位符，缺失即拒写（settings 响亮失败路径） |
| C6 | sub2api 上游依赖 | **不依赖上游——用户自行改造自己的 sub2api 部署**（§12 即自改造施工说明）；方案 A/B 由部署者实现，A3 不再受上游发布节奏约束 |
| C7 | REAL composition 测试 | A1 一并补齐（mock sub2api server + 真实组合断言） |

## 10. 风险

1. **版本下限收紧到 0.2.0-rc.2**：0.1.x 代 app 上 client 半部因缺 `configForms`/locale 服务而 boot 失败（响亮、可诊断，列出未激活条目）；host 半部不受影响（`loader/volatile-update` 模式跨代稳定，cookbook 即现行文档）。README 显式标注。
2. **0.2.0-rc.2 是 rc 线**：后续 0.2.x 演进可能再动服务面（前例：settingsScope→configForms）——所有官方缝访问收敛在 `useConfigForm.ts` / `mount.ts` 两处，迁移面可控。
3. **ui-primitives 依赖 app 提供**——平台模块机制保证；缺失时 bundle 加载响亮失败。
4. **面板 API 无稳定性承诺**——A1 沿用「必需字段校验、宽容读取、响亮失败」既定缓解。
5. **i18n 门禁覆盖不到树外包**——以 key 集一致测试 + 评审约定替代，字典单文件集中（`locales.ts`）。
6. **双写过渡**——U1 一次性切换配置缝，不留长期双轨；切换前 README 标注主卡为分组管理唯一入口。
7. **跨设备 web 双重平台限制**——`memory` 持久化（配置进程本地）+ `trustedRequest` 回环信任（动作 403）：缓解 = 降级警示条 + 禁写禁动作 + `allowRemoteActions` 逃生门默认关闭（§11）；不对抗平台安全姿态。
8. **上游依赖时序**——C2/A3 依赖 sub2api 方案 B 发布：能力探测隐藏入口、C1/C3 先行保底；以 §12 的端点契约向上游提 issue，PAT（方案 A）体量小、可独立先行。
9. **config/credentials 漂移**——keyId 在 config、明文在 credentials，两侧可能不同步（用户手删凭据 / 手滑清字段）：凭据缺失有 keyId → List 回填（已设计）；keyId 丢失但凭据在 → 「自动」按组名匹配大概率找回；两者皆失 → 新建 key（可接受，UI 以报告提示）。边缘组合在 A1 单测中列矩阵覆盖。
10. **Mode B → Mode A 迁移缝隙（待决策，见 §14）**——指纹路由条目与面板真实分组的接管/清理语义未定。
11. **勾选后部分失败**——N 个分组勾选同步、M 个失败（如该分组无可用模型）：条目缺位但勾选仍在，定时/手动重试会持续重试；分组行需要失败标记与「跳过该组」动作，避免静默循环失败（A2 细化）。

## 11. 双端支持：桌面（Electron）与 web

**结论：同一 client bundle 双端通用，无分叉构建。** 0.2.0 客户端插件契约（slots/locale/configForms/平台模块）都是 web 平台面，桌面 renderer 加载同一 web 组合，仅多出可选原生桥（官方即用 `'dshDesktop' in globalThis` 做**可选增强**而非分叉——本插件完全不依赖它）。差异只有三处，全部收敛处理：

| 差异点 | 桌面 | web（本机浏览器） | web（跨设备） |
|---|---|---|---|
| 打开授权页 | `window.open` 外链 → 默认浏览器 | 同 | 同（copy-link 兜底） |
| settings 持久化 | `isLoopback=true` → `host` 模式，可写 | 同 | `isLoopback=false` → `memory` 模式，`writable=false`（核实自 `ui-settings/src/client/index.ts:39`） |
| 宿主路由可达性 | 回环 ✅ | 回环 ✅ | `trustedRequest` 拒非回环 peer（现行为）；**唯一例外 = `/oauth/callback`**（state 校验代替网络位置，见 §5.1 路由表——否则跨设备 C2 必断） |

处理原则：

1. **同机全功能对等**：桌面与本机 web 的功能集完全一致（配置可写、动作可达、C2 授权回调落在同一 origin）。
2. **跨设备 web 降级**：两道平台限制叠加——配置写入仅进程本地（`memory` 模式）、动作路由 403。行为：卡片顶部警示条 + 表单禁写 + 同步按钮禁用 + 「请在 harness 宿主机本机界面操作」指引。这是平台安全姿态（远程页面不落共享宿主文档），跟随而非对抗。
3. **显式逃生门**：Config 增 `allowRemoteActions: boolean`（缺省 false，cordis.yml/调参卡可开）——自建内网用户可放开 `trustedRequest` 的 peer 限制为「同源 + 私网网段」；开启时 README 响亮警示（动作路由可改写模型路由与凭据）。默认永远关闭。
4. **桌面原生增强不做**：官方的原生平台页/账户桥（`dshPlatform`）是 DeepSeek 平台特有，sub2api 无对应物；本插件用标准 `window.open` + 回调路由即覆盖双端。

## 12. sub2api 自改造清单（不依赖上游，部署者自行实施）

按改动量升序；A/B 是插件双端完整体验的两块基石，C 可选，D 明确不做。全部改动集中在 `backend/internal`（router/auth/handler/user domain）+ console 前端一处设置页，不动网关转发面。

### 方案 A：PAT（Personal Access Token）——最小改动，优先做

用户在 console 生成一把长期面板令牌，插件拿它直调面板 API（`Authorization: Bearer <pat>`），密码登录整体退役为兼容通道。

- **模型**：`personal_access_tokens` 表（`id, user_id, name, token_hash(sha256), last_used_at, expires_at?, revoked_at?`）；创建响应里**仅一次**返回明文（`sk-sub2api-…` 形态）。
- **端点**：`GET/POST /api/v1/tokens`、`DELETE /api/v1/tokens/:id`（复用现有 auth middleware 的注册模式，加一条 PAT 鉴权分支：查 hash → 挂 user → 记 `last_used_at`）。
- **鉴权面**：仅面板 API（`/api/v1/*`），明确不覆盖网关 `/v1/*`（网关继续走 relay key——两类密钥语义分离）。
- **console**：设置页加「访问令牌」区（列表/创建/吊销），无 consent 流程。
- **插件侧成本**：≈0（`Sub2apiClient` 面板半部的 auth 头本就是 Bearer，PAT 即插即用；C1 通道交付）。
- **上游风险**：低——与既有 API key 管理同构；审计/吊销语义现成。

### 方案 B：OAuth2 授权码 + PKCE——「像官方一样网页登录」的完整形态（自改造施工说明）

新增一组授权端点，让插件以官方 DeepSeek 登录的同款形态跳转登录、回 code、换 token。以下为推荐实现，可直接照施工：

**前提确认（已由用户实例核实，2026-09-30）**：console 认证为「access token 存 localStorage + `Authorization: Bearer` 请求头」（curl 实证：面板请求凭 Bearer 头，cookie 仅为 Cloudflare/Stripe 风控非会话）→ authorize/consent **做成 SPA 路由**，按下述形态施工。

**0. 部署前提：Cloudflare 放行宿主侧调用（实例前置 CF 的场合）**

用户实例位于 Cloudflare 之后（`cf_clearance`）。浏览器侧（登录页、consent、redirect 跳转）有人类通行证自然通过；但**插件宿主侧调用**（`POST /oauth/token` 换发、groups/keys 同步、模型发现）是 harness 服务器的纯 HTTP 请求，无 cf_clearance，可能被托管质询拦截。部署前提：在 CF zone 加 WAF 规则——`http.request.uri.path starts_with "/api/v1/"` → Skip 托管质询（或按自定 service header 放行）。Turnstile 登录页本身不受影响（浏览器侧）。

**1. 端点契约（三个）**

| 端点 | 认证 | 行为 |
|---|---|---|
| `GET /api/v1/oauth/authorize` | 无 | 纯转发：`302 → console SPA 路由 /oauth-consent?<原 query 原样>`。无任何逻辑 |
| `POST /api/v1/oauth/authorize` | 面板 Bearer JWT | consent 提交。body：`{client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, decision:'allow'\|'deny'}`。校验通过 → 生成 code → 答 `{redirect:"redirect_uri?code=…&state=…"}`（deny → `error=access_denied`）；前端 `window.location.href = redirect` |
| `POST /api/v1/oauth/token` | 无（公开） | `grant_type=authorization_code` + `code` + `redirect_uri` + `code_verifier` → 校验链全过 → 签发与 `/auth/login` **同构**的 `{access_token, refresh_token, expires_in, token_type, user}` |

**2. 校验与存储规则**

- `client_id` / `redirect_uri`：**数据库表 + console 管理页**（用户拍板，GitHub OAuth Apps 形态；官方 DeepSeek 侧的注册表在私有包中无从参照，此为自定实现）：`oauth_clients(id, client_id unique, name, redirect_uris JSON, enabled, created_by, created_at)`。公钥客户端**无需 client_secret**（PKCE + 精确 redirect 匹配承担安全）；redirect_uri **全串精确匹配**，禁止前缀/包含匹配；可变部分只有 origin（path 恒为 `/plugins/dsh-sub2api-sync/oauth/callback`），管理页可加「一键登记当前 harness origin」辅助；
- `code`：32 字节随机 base64url；只落 **sha256 hash**；TTL ≤ 60s；**原子一次性消费**（`UPDATE … SET consumed_at=now() WHERE consumed_at IS NULL`，防并发重放）；绑定 user_id + client_id + redirect_uri + challenge；
- PKCE：仅接受 `code_challenge_method=S256`（拒绝 plain），verifier 长度 43–128；
- `state` 不落库——插件宿主自持并在 callback 校验（防 CSRF 责任在客户端，标准分工）。

**3. 令牌签发与 scope**

- 签发**复用现有 login 的 JWT 函数**——access/refresh 与密码登录同构，现有 `/auth/refresh` 零改动即可续期；
- claims 附加 `oauth_client_id` 与 `scope`；scope = `groups:read`（`GET /groups/available`、`/groups/rates`）+ `keys:manage`（`/keys` CRUD）。两档实现任选：**v1 简化** = OAuth token 与登录 token 同权，scope 仅在 consent 页展示；**v1 完整** = 两个路由组加 scope 检查助手（约二十行）。

**4. Turnstile/TOTP/登录页——零改动**

authorize SPA 未检测到登录态 → 跳 console 登录页（`?next=/oauth-consent?…`）→ 登录页内自然完成验证码与 2FA → 回 consent。这正是该方案对 captcha 实例的价值来源：**验证码永远由真人在真实登录页完成**。

**5. 前端（console）改动量**：一个 consent 页（client 名 + scope 列表 + 允许/拒绝）+ 一个 SPA 路由守卫复用现有登录跳转。可选「记住对此应用的授权」为 v2 项。

**6. 自改造完成判据（验收用例）**

1. 未登录走 authorize → 跳登录（Turnstile/TOTP 照常）→ consent → redirect 带 `code`/`state`；
2. 同一 code 第二次换 token → 拒绝；verifier 错误 → 拒绝；>60s → 拒绝；
3. redirect_uri 篡改 → authorize 与 token 两端点都拒绝；
4. deny → `error=access_denied` 回调；
5. 插件全流：网页登录 → 分组勾选 → 同步 → 模型选择器可用。

**可选增补**：RFC 8628 设备码流（`POST /api/v1/oauth/device/code` + `.../device/token`），供 redirect 白名单不便覆盖的临时场景；非必需。

### 方案 C（可选）：分组变更通知

`groups/available` 与 key 语义已满足同步（零改动）。若想免轮询，可加最小 webhook：用户级「分组变更 → POST <回调>」设置；插件侧只是把定时重同步变成事件触发。非本方案依赖。

### 方案 D（明确不做）：CORS 直连

不给面板 API 开 CORS——那会把面板 token 暴露进浏览器进程，且失去宿主侧统一校验/脱敏。保持「浏览器半部 → harness 宿主路由 → sub2api 面板」的代理形态（官方账户域同姿态）。

### 不改上游时的能力矩阵（现状通道）

| 能力 | 密码+2FA（C3） | 手动 key（Mode B） |
|---|---|---|
| 双端同机 | ✅ | ✅ |
| Turnstile/TCaptcha 实例 | ❌ 响亮指引 Mode B | ✅（粘贴现成 relay key） |
| 分组发现/自动建 key | ✅ | ❌（key-first 指纹路由） |
| 持续同步（分组/模型增删） | ✅ | 部分（模型列表随 key 发现） |

即：上游不动，插件双端仍可用，只是 captcha 实例退回 Mode B、且没有「网页授权」仪式感——这正是 §12-A/B 值得向上游提 issue 的论据。

## 13. 非目标

- 不注册 `root` / 不组合 settings shell 内部 / 不进输入区 chain（槽位纪律）；
- 不做用量面板（既有决策，去 sub2api 控制台）；
- 不自建 WebSocket/推送通道（状态复用 settings 投影 + `/status`、`/oauth/status` 轮询；Remote namespace 迁移另行立项）;
- 不在模型页做编辑（模型页只读 + 跳转，编辑只在自家 section 与插件页调参卡）；
- 不为 0.1.x 代 app 提供兼容层（rev.2 决策）；
- 不在浏览器半部直连 sub2api API（不开 CORS 依赖，所有面板调用宿主侧代理，token 不落浏览器——见 §12-D）。

---

## 15. rev.6 变更：Keys 驱动同步（替代分组驱动）

实施中据实机反馈调整的数据模型（原「一分组一供应商、单 keyId」改为「**一选中 key 一供应商**」）：

| 维度 | rev.5（分组驱动） | rev.6（Keys 驱动） |
|---|---|---|
| 配置字段 | `enabledGroups: number[]` + `groups.<groupId>.keyId` | `selectedKeys: number[]`（key id 面板内唯一） |
| 路由 | `sub2api-<分组id>` | `sub2api-<keyId>`（归属判定 `/^sub2api-\d+$/` 与凭据引用形状不变） |
| 凭据引用 | `DSH_SUB2API_KEY_<分组id>` | `DSH_SUB2API_KEY_<keyId>` |
| Key 来源 | 每分组三态（自动建/选已有/粘贴） | Keys 卡勾选（多选、可跨分组）；创建经弹窗（默认与分组同名） |
| 分组 UI | 分组卡：勾选 + 每行 key 来源 + 预览 | **移除**；分组仅用于分组名、平台映射与创建 key 的目标 |
| 触发同步 | 分组卡的「立即同步」（按 `enabledGroups`） | Keys 卡「同步所选（N）」；主卡「同步」块仍可全量触发并显示报告 |
| 引擎 | `buildTargetProfile(group)` 三态解析 + 自动建 key + keyId 持久化 | `buildKeyProfile(key, group)`：明文取面板列表→凭据回退；无自动建/无 keyId 持久化 |
| 移除语义 | 未勾选分组 → 删路由 + 凭据 + （可选）撤销远端 key | 未勾选 key → 同上；路由自带 key id，撤销总是可寻址 |

配套清理（rev.6）：宿主 `/key`（粘贴）、`/group-keys`、`/discover` 三个路由及其 deps 与客户端 API 方法因语义过期（按分组写凭据）而移除；`/keys` 上下文改为「列表分页 + 创建」，与面板控制台调用形态逐参数对齐（`page`/`page_size`/`sort_by=created_at`/`sort_order=desc`/`timezone` + `X-User-UI-Request: 1`）。

未决：面板掩码明文时的**按 key 粘贴**兜底通道（`POST /keys/paste {keyId, key}`）尚未实现；当前行为是响亮失败并提示管理员登录。
