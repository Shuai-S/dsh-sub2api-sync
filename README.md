# dsh-sub2api-sync

[![Release](https://github.com/Shuai-S/dsh-sub2api-sync/actions/workflows/release.yml/badge.svg)](https://github.com/Shuai-S/dsh-sub2api-sync/actions/workflows/release.yml)
[![npm (canonical)](https://img.shields.io/npm/v/%40mangoc/dsh-sub2api-sync?label=npm%40mangoc)](https://www.npmjs.com/package/@mangoc/dsh-sub2api-sync)
[![npm (alias)](https://img.shields.io/npm/v/dsh-sub2api-sync?label=npm%20alias)](https://www.npmjs.com/package/dsh-sub2api-sync)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**中文说明：[README.zh.md](README.zh.md)**

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that syncs one [sub2api](https://github.com/Wei-Shaw/sub2api) instance's groups, relay keys, and models into `dsh-llm-pi-ai` provider routes — log in once, integrate automatically, keep syncing.

## Highlights

- **Panel-driven login** — panel email/password (+TOTP); the web OAuth + PKCE channel lands once sub2api deploys its OAuth endpoints.
- **Keys-driven sync** — tick one or many relay keys from the panel's Keys card (cross-group); **one key becomes one provider** under a stable route name `sub2api-<10-hex>` that leaks no key ordering.
- **Model experience** — model catalog from instance discovery, enriched from the models.dev directory (display names, context windows, image input, reasoning efforts) with a bundled offline snapshot fallback.
- **Secrets stay secret** — panel tokens, passwords, and relay keys live only in the harness credential store; never in settings, logs, or sessions.
- **Bilingual UI** — full zh/en settings card and plugin config card.
- **Coexists cleanly** — the community plugin `GodD6366/dsh-sub2api` can stay installed; route names and credential references do not collide.

**Requirements**: DSH ≥ 0.2.0-rc.2 · Node ≥ 22.19 · a sub2api panel account that can read relay key plaintext (admin).

## Install

Four equivalent channels — all ship the built `lib/`, no local build needed.

**npm** — two names, same code, same version (scoped canonical + unscoped alias):

```sh
dsh plugin --profile web add @mangoc/dsh-sub2api-sync
# or
dsh plugin --profile web add dsh-sub2api-sync
```

**GitHub Releases** — stable-name tarballs that always point to the latest release:

```sh
dsh plugin --profile web add https://github.com/Shuai-S/dsh-sub2api-sync/releases/latest/download/mangoc-dsh-sub2api-sync.tgz
# or the short-name variant
dsh plugin --profile web add https://github.com/Shuai-S/dsh-sub2api-sync/releases/latest/download/dsh-sub2api-sync.tgz
```

Version-pinned tarballs (e.g. `mangoc-dsh-sub2api-sync-0.1.0.tgz`) are on the [Releases page](https://github.com/Shuai-S/dsh-sub2api-sync/releases).

**From source** — pnpm runs the `prepare` build on git dependencies (needs a local toolchain):

```sh
dsh plugin --profile web add github:Shuai-S/dsh-sub2api-sync#path:packages/llm/sub2api-sync
```

> While this repository is private, the two GitHub channels require repository access.

After installing, restart the app or toggle the plugin off/on; failed entries are not retried automatically.

## Usage

1. Click **Login** in the settings card, enter the instance URL (e.g. `https://cn.api.nexarelay.com`) plus panel credentials (TOTP supported; the password is stored in the credential store).
2. The **Keys** card lists the instance's relay keys — tick one or many (cross-group), or create a new key inline.
3. Hit **Sync selected (N)** — the engine builds **one provider per key**, discovers models, and writes routes into `llm-pi-ai.providers`.
4. Models become selectable on the next request; the sync report supports per-entry removal (local routes and credentials only, the panel is never called).

Full manual: [packages/llm/sub2api-sync/README.zh.md](packages/llm/sub2api-sync/README.zh.md) · [English](packages/llm/sub2api-sync/README.md)

## Repository layout

| Path | Contents |
|---|---|
| `packages/llm/sub2api-sync/` | The plugin package: server half (`src/`), client UI (`src/client/`), tests, locale, offline model snapshot |
| `docs/design/` | Design notes: Phase 1 sync engine, client UI rev.5, OAuth provider |
| `.github/workflows/release.yml` | Tag-driven dual-channel release (GitHub Release + npm dual publish) |

## Development

```sh
pnpm install   # installs deps and runs the prepare build
pnpm check     # typecheck + tests + build
dsh plugin --profile web add ./packages/llm/sub2api-sync
```

`dsh plugin add` only symlinks local directories — build first (`pnpm build`), or the plugin never activates.

## Release (maintainers)

1. Bump `version` in `packages/llm/sub2api-sync/package.json`.
2. Commit, then `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. CI runs checks, packs **both published names** (scoped canonical + unscoped alias — the plugin identity is injected per variant), creates the GitHub Release with 4 tarball assets, and publishes to npm.

> The first publish of a brand-new package name parks in npm's **Staged Packages** queue — confirm it once on npmjs.com; later releases go straight through.

Manual dual publish: [packages/llm/sub2api-sync/README.md](packages/llm/sub2api-sync/README.md).

## License

[MIT](LICENSE)
