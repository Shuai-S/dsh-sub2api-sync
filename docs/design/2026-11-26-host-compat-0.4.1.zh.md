# 0.4.1 宿主版本兼容修复（决策记录）

Status: implemented · 2026-11-26

## 触发

宿主在 0.2.0-rc.2 之后连发多个版本（桌面 0.2.1-rc.4、npm next 0.2.2-rc.5、alpha 0.2.3-alpha.2），插件把所有宿主依赖钉在 0.2.0-rc.2，且没有任何会报警的闸门。实测发现两类问题：

1. **契约漂移且静默**：`@deepseek-ai/dsh-client-ui-primitives` 自 **0.2.2-rc.2** 起删除 `useAnchoredPosition`（0.2.2-rc.1 还有），插件的 GroupPicker 仍在调用 → `tsc` 报 TS2305，而 tsdown 不做类型校验、既有测试只对 CSS 文本断言，于是 build 与 347 项测试全绿，运行期在 rc.2+ 宿主上打开「新建密钥」下拉即 `TypeError`。
2. **声明产物不可用**：0.4.0 发到 npm 的 `lib/index.d.ts` 等 **12 个文件里 7 个损坏**（如 `from './co./config.jseclare module …`），tsdown 0.4.4 的 dts 步骤把相邻语句熔进一行且**保持字节长度**，因此体积/哈希校验都发现不了；任何 TS consumer 在 `skipLibCheck` 开或关时都编译失败。

另一处与版本号直接相关的事实：DSH 的准入判定用 `semver.satisfies(runtime, range, { includePrerelease: true })`（`dsh-app-boot/lib/index.js`），所以 `>=0.2.0-rc.2` 对 0.2.1/0.2.2 全部通过——**门禁不拦 = 没有安全网**，这正是「版本号看着对但实际已跑到契约外」的成因。

## 决策与依据

| 议题 | 决策 | 依据 |
|---|---|---|
| GroupPicker 定位 | 自持（vendored）`usePanelPosition.ts` | 迁移到 `Menu` 会回退四处：宽度从「严格等于 trigger」变成「至少」、键盘语义被 Menu 拦截、ARIA 从 listbox 降为 menu、`portal` 依赖 CSS anchor positioning（纯浏览器 GUI 风险）。vendored 仅约 50 行几何代码，跨 rc.4/rc.5 行为一致 |
| 声明产物 | `tsc -p tsconfig.dts.json --emitDeclarationOnly`，tsdown `dts: false` | 实测四变体：只升 tsdown（0.23.7）会让 `schemastery` 混进浏览器 bundle、被仓库 `client-bundle.test.ts` 判死（345/347）；`alwaysBundle` 又超 120 KiB 预算（346/347）；改源码绕开只剩 612 B 余量。tsc 方案输出文件集与 JS 逐字节不变 |
| 宿主依赖形态 | 宿主包只作 peer（`@deepseek-ai/dsh-credentials` 由 dependencies 移入 optional peer） | 宿主 `profile-resolution-bootstrap` 按**插件 package.json 的 peerDependencies 名**把裸导入重定向到自身安装；dsh-config-manager 等社区插件同样只用 peer，且其 profile 内无宿主副本。实测 scratch profile 安装后宿主副本为 0、`schemastery` 由插件自带并可解析 |
| 兼容声明 | `engines.dsh: >=0.2.0-rc.2 <0.3.0-0` | `engines.dsh` 存在即单独决定准入（peer 被忽略）；`<0.3.0` 挡不住 `0.3.0-0`/`0.3.0-alpha.1`，必须 `-0` 后缀 |
| 构建基线 | devDeps 全部升 `0.2.2-rc.5`、cordis `4.1.0`；overrides 整体移除、改为精确 pin + `minimumReleaseAgeExclude` | 原 overrides 里 `dsh-invariants`/`dsh-code-runtime` 从未发布 0.2.x 版本，一旦被请求就 `ERR_PNPM_NO_MATCHING_VERSION` |

## 验证（全部实测）

- `pnpm check`：typecheck + **356** 项测试 + build + `check-dts` 全绿（exit 0）。
- `scripts/check-dts.mjs`：对 tsdown-only 构建 exit 1（12 文件 / 228 处问题），对 tsc 产物 exit 0（12 文件、82,976 字节、无熔接特征）；数量/字节相同，证明损坏是保长的。
- consumer 冒烟：`skipLibCheck: false` 下 Bundler / NodeNext / Node10 三种解析全部 exit 0，且可直接 `import type { ResolvedSub2apiSyncConfig, Sub2apiSyncConfig }`（这两个类型此前未从包根导出，已补）。
- 准入矩阵：0.2.0-rc.2 … 0.2.3-alpha.2 全部 ADMITTED；0.3.0-0 / 0.3.0-alpha.1 / 0.3.0 全部 REFUSED。
- 客户端 bundle：111,280 B（预算 120 KiB），external 仍只有 react、react/jsx-runtime、dsh-client-ui-primitives；`useAnchoredPosition` 仅剩注释里的历史说明。
- 打包：28 个文件，无临时产物；宿主半部运行期仅导入 `dsh-credentials`（peer）、`schemastery`（自带）与 node 内建。

## 遗留（未纳入 0.4.1）

- CI 宿主矩阵（每次发布对 `next` 与上一稳定线各跑一遍 typecheck）与「宿主 next 哨兵」（导出增删比对后开 issue）——本轮用 `check-dts` + 既有 bundle 纯度/体积测试 + `engines.dsh` 三道确定性闸门兜住已知风险。
- 设置卡的宿主兼容状态显示（读宿主版本对比 `engines.dsh`）。
