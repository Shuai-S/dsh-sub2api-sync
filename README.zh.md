# dsh-sub2api-sync

[![Release](https://github.com/Shuai-S/dsh-sub2api-sync/actions/workflows/release.yml/badge.svg)](https://github.com/Shuai-S/dsh-sub2api-sync/actions/workflows/release.yml)
[![npm (canonical)](https://img.shields.io/npm/v/%40mangoc/dsh-sub2api-sync?label=npm%40mangoc)](https://www.npmjs.com/package/@mangoc/dsh-sub2api-sync)
[![npm (alias)](https://img.shields.io/npm/v/dsh-sub2api-sync?label=npm%20alias)](https://www.npmjs.com/package/dsh-sub2api-sync)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**English: [README.md](README.md)**

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：把一个 [sub2api](https://github.com/Wei-Shaw/sub2api) 实例的分组、中继密钥、模型同步为 `dsh-llm-pi-ai` 的 provider 路由——登录一次、自动集成、持续同步。

## 特性

- **面板驱动登录**——面板邮箱/密码（+TOTP）；sub2api 侧部署 OAuth 端点后接入网页授权（PKCE）通道。
- **Keys 驱动同步**——在 Keys 卡勾选一把或多把中继密钥（可跨分组），**一把 key 一个供应商**，路由名 `sub2api-<10-hex>` 稳定且不暴露 key 顺序。
- **模型体验**——模型目录来自实例发现，并按 models.dev 目录补全（显示名称、上下文窗口、图片输入、推理档位），失败自动降级到随包内置快照（完全离线可用）。
- **秘密不落盘**——面板 token、密码、中继密钥只进 harness 凭据存储，不进 settings、不进日志、不进会话。
- **全双语 UI**——设置卡与插件调参卡完整 zh/en 文案。
- **共存友好**——社区插件 `GodD6366/dsh-sub2api` 可同装，路由名与凭据引用互不冲突。

**环境要求**：DSH ≥ 0.2.0-rc.2 · Node ≥ 22.19 · 能看到中继密钥明文的 sub2api 面板账号（管理员）。

## 安装

四条等价渠道——都自带构建产物 `lib/`，无需本地构建。

**npm**——两个包名、同一份代码、同版本号（scoped 为 canonical，无 scope 为短名别名）：

```sh
dsh plugin --profile web add @mangoc/dsh-sub2api-sync
# 或
dsh plugin --profile web add dsh-sub2api-sync
```

**GitHub Releases**——固定名 tarball，始终指向最新版：

```sh
dsh plugin --profile web add https://github.com/Shuai-S/dsh-sub2api-sync/releases/latest/download/mangoc-dsh-sub2api-sync.tgz
# 或短名变体
dsh plugin --profile web add https://github.com/Shuai-S/dsh-sub2api-sync/releases/latest/download/dsh-sub2api-sync.tgz
```

带版本号的 tarball（如 `mangoc-dsh-sub2api-sync-0.1.0.tgz`）见 [Releases 页](https://github.com/Shuai-S/dsh-sub2api-sync/releases)。

**从源码**——pnpm 会对 git 依赖自动执行 `prepare` 构建（需要本机构建链）：

```sh
dsh plugin --profile web add github:Shuai-S/dsh-sub2api-sync#path:packages/llm/sub2api-sync
```

> 仓库处于私有状态时，两条 GitHub 渠道需要仓库访问权限。

装好后重启应用、或在插件页把开关关掉再打开；失败的条目不会自动重试。

## 使用

1. 在设置卡点**登录**，填实例地址（如 `https://cn.api.nexarelay.com`）+ 面板凭据（支持 TOTP；密码存入凭据存储，之后免输入）；
2. **Keys 卡**列出实例的中继密钥——勾选一把或多把（可跨分组），也可就地新建 key；
3. 点**同步所选（N）**——引擎为每把 key 建一个供应商，发现模型并写入 `llm-pi-ai.providers`；
4. 模型下一请求即可用；同步报告支持逐条**移除**（只删本地路由与凭据，不调面板）。

完整手册：[packages/llm/sub2api-sync/README.zh.md](packages/llm/sub2api-sync/README.zh.md) · [English](packages/llm/sub2api-sync/README.md)

## 仓库结构

| 路径 | 内容 |
|---|---|
| `packages/llm/sub2api-sync/` | 插件包：服务端半部（`src/`）、客户端 UI（`src/client/`）、测试、locale、离线模型快照 |
| `docs/design/` | 设计笔记：Phase 1 同步引擎、客户端 UI rev.5、OAuth provider |
| `.github/workflows/release.yml` | tag 驱动的双渠道发布（GitHub Release + npm 双发布） |

## 开发

```sh
pnpm install   # 安装依赖并触发 prepare 构建
pnpm check     # typecheck + 测试 + 构建
dsh plugin --profile web add ./packages/llm/sub2api-sync
```

`dsh plugin add` 对本地目录只做软链——必须先 `pnpm build`，否则插件不会激活。

## 发布（维护者）

1. 改 `packages/llm/sub2api-sync/package.json` 的 `version`；
2. 提交后 `git tag vX.Y.Z && git push origin vX.Y.Z`；
3. CI 自动跑检查、按**两个包名**分别打包（scoped canonical + 无 scope 别名，插件身份按变体注入）、创建带 4 个 tarball 资产的 GitHub Release、双发布 npm。

> 全新包名的首次发布会在 npm **Staged Packages** 队列停留，去 npmjs.com 确认一次即可；之后的版本直接通过。

手动双发布见 [packages/llm/sub2api-sync/README.zh.md](packages/llm/sub2api-sync/README.zh.md)。

## 许可证

[MIT](LICENSE)
