# @mangoc/dsh-sub2api-sync

Sync one [sub2api](https://github.com/Wei-Shaw/sub2api) instance's groups, keys, and models into [`dsh-llm-pi-ai`](https://github.com/deepseek-ai/deepseek-harness) provider routes: log in once, integrate automatically, keep syncing.

Design Agent Note: see [the design notes](../../../docs/design/2026-09-04-sub2api-provider-sync.md) and [Chinese version](../../../docs/design/2026-09-04-sub2api-provider-sync.zh.md).

## Status: Phase 1 (key-first, Mode B)

Phase 1 ships the key-first path: declare groups by hand in the settings card, paste each group's relay key, and sync. The panel-driven path (Mode A: email/password login, 2FA, automatic key creation, group discovery, models.dev metadata enrichment, scheduled resync, the `sub2api_sync` tool) lands in Phase 2.

## Install

### User install (release channels)

The harness loads this package through its `main`/`exports` entry, which is the
**built** `lib/index.js`. Tarballs from any channel below ship `lib/` already —
no local build needed:

**npm** — published under two names simultaneously: same code, same version.
The scoped name is canonical; the unscoped short name is an alias. Either
installs as a first-class plugin:

```sh
dsh plugin --profile web add @mangoc/dsh-sub2api-sync   # canonical (scoped)
dsh plugin --profile web add dsh-sub2api-sync           # alias (unscoped short name)
```

**GitHub Releases tarball** (no npm involved; the URLs always point to the
latest release; both variants are equivalent):

```sh
dsh plugin --profile web add https://github.com/Shuai-S/dsh-sub2api-sync/releases/latest/download/mangoc-dsh-sub2api-sync.tgz
# or the short-name variant:
dsh plugin --profile web add https://github.com/Shuai-S/dsh-sub2api-sync/releases/latest/download/dsh-sub2api-sync.tgz
```

You can also copy a version-pinned tarball URL (e.g.
`mangoc-dsh-sub2api-sync-0.1.0.tgz` / `dsh-sub2api-sync-0.1.0.tgz`) from the
[Releases page](https://github.com/Shuai-S/dsh-sub2api-sync/releases).

**From source** (pnpm runs the `prepare` build on git dependencies; needs a
local toolchain and is slower on first install):

```sh
dsh plugin --profile web add github:Shuai-S/dsh-sub2api-sync#path:packages/llm/sub2api-sync
```

After installing, restart the app or toggle the plugin off/on so the entry is
imported again; a failed entry is not retried on its own.

### Release (maintainers)

Every release publishes **both names in lockstep**
([scripts/pack-all.mjs](scripts/pack-all.mjs)): one tarball for the scoped
canonical name and one for the unscoped alias, sharing the same version. Each
variant embeds its own plugin name at pack time (client-bundle `PKG_NAME`,
ModuleLoader wrapper id, `cordis.patch.yml`), so both install independently.
CI ([.github/workflows/release.yml](../../../.github/workflows/release.yml))
runs the whole flow: bump `version` in
`packages/llm/sub2api-sync/package.json` → commit →
`git tag vX.Y.Z && git push origin vX.Y.Z` → `pnpm check` → two tarballs →
GitHub Release (4 assets: 2 versioned + 2 stable-name copies) → npm dual
publish (requires the repo secret `NPM_TOKEN`; `publishConfig.registry` is
pinned to the official npmjs registry, immune to mirror configs). Manual dual
publish from a local checkout:

```sh
pnpm pack:all    # emits both tarballs into dist/; repo files restored afterwards
npm publish dist/mangoc-dsh-sub2api-sync-*.tgz --registry=https://registry.npmjs.org --access public
npm publish dist/dsh-sub2api-sync-*.tgz --registry=https://registry.npmjs.org --access public
```

Publishing only the canonical package also works:
`pnpm --filter @mangoc/dsh-sub2api-sync publish`.

### Local development (linked checkout)

`dsh plugin add` only symlinks a local directory (`link:`); it does **not**
install or build the target, so building first is a hard precondition — not
just a development convenience:

```sh
pnpm install          # installs deps (runs the `prepare` build)
pnpm build            # tsdown + client wrapper; emits lib/index.js and lib/client.js
dsh plugin --profile web add ./packages/llm/sub2api-sync
```

After rebuilding, restart the app or toggle the plugin off/on so the entry is
imported again; a failed entry is not retried on its own.

## Configuration

Open **Settings → Sub2API 同步** (or edit `$DSH_HOME/settings.yaml` under the `sub2api-sync:` section; the cordis.yml entry is the base layer):

```yaml
sub2api-sync:
  baseURL: https://sub2api.example.com
  manualGroups:
    "12":
      name: Claude 拼车
      platform: anthropic
    "15":
      platform: openai
  # Optional:
  enabledGroups: []                 # empty = all declared groups
  protocolOverrides:
    "15": openai-completions        # force a wire protocol per group
  modelListOverrides:
    "15": [gpt-x, gpt-y]            # fallback when /v1/models is unreachable
  compatTemplate:
    compat:
      supportsDeveloperRole: false  # inherited by every synced model entry
```

Relay keys never live in settings: paste each group's key once in the card; it is stored through the harness credential seam under the deterministic reference `DSH_SUB2API_KEY_<group-id>`.

## What a sync does

For every declared group with a stored key, the engine:

1. calls `GET {instance}/v1/models` with that group's key (falling back to `modelListOverrides` on failure);
2. maps the group's platform onto a wire protocol — `anthropic` → `anthropic-messages`, the OpenAI family (`openai`/`grok`/`kimi`/`zhipu`/`deepseek`) → `openai-responses`, the rest (`gemini`/`antigravity`/`composite`) → `openai-completions` — overridable per group;
3. derives the profile `baseURL` per protocol (OpenAI-family SDKs get `{instance}/v1`; the Anthropic SDK gets the bare host, since it appends `/v1/messages` itself);
4. writes a hand-declared `llm-pi-ai` provider profile at `providers.sub2api-<10-hex>` through a scoped `settings.mutate` carrying `expectedRevision` (three conflict-retry attempts), with a lenient retry policy (5 retries / 120 s backoff cap) tuned for proxied upstream 429 windows.

Routes take effect on the next request. The route suffix is a SHA-256 truncation over (instance baseURL, panel key id) — stable, collision-free across instances, and it deliberately carries no trace of the panel's sequential key numbering (a shared config screenshot reveals nothing about how many keys the site has issued). Entries only ever cover the `sub2api-<10-hex>` (current) and `sub2api-<digits>` (legacy, migrated on the next sync) shapes — the ownership boundary. Anything else in `llm-pi-ai.providers` (your hand-entered routes, other plugins' routes) is never touched. Keys that disappear from the selection lose their entry and their credential; the remote key itself is only revoked when `deleteOrphanKeys` is enabled. Each **registered-route row** in the sync card carries a **Remove** button — it deletes the local route and credential only (**no panel calls**, so it works even with an empty balance) and unchecks the key so the next sync cannot resurrect it; the report below stays a read-only hint of the last run. Logout, definitive auth loss, and instance switches purge the plugin's sync state site-wide — owned routes, relay-key credentials, and the last sync report go together (a report describing state that no longer exists must not keep rendering).

## Model Experience

- **Context blocks (short form)**: one provider per sub2api group, one relay key per provider, model catalog discovered from the instance; per-model `compat` inherits the user template. Reasoning efforts (`reasoningEfforts`) follow an explicit template when set (including `false`), and otherwise auto-fill per model from the models.dev enrichment.
- **Reasoning-effort auto-fill**: the models.dev `reasoning_options` effort enumeration maps onto pi-ai's `reasoningEfforts` (`none` → `off: null`, same-name passthrough otherwise). Merging is first-party first: a vendor-official entry (openai/anthropic/google/zhipuai/zai/deepseek/moonshotai/xai/alibaba, vendor-governed cloud hosting) wins outright — including when it carries no effort data (budget-only claude/gemini), which silences aggregator-invented vocabularies; with no first-party entry, aggregator sources intersect. Toggle/budget-only reasoning (claude, gemini, deepseek-v3.2, kimi-k2.x) has no effort-string wire shape and stays template/`compat`-owned.
- **Display-name enrichment**: the models.dev `name` lands on each pi-ai model entry's `name` field — the display name the model selector and the model-catalog editor (显示名称 column) show. The models.dev " (latest)" family marker is stripped, a name repeating the id is dropped, merging is first-party first (official name overrides, aggregator names fill absences), and a name can be an id's only enriched fact.
- Model ids come verbatim from the instance; the provider display name is the `providerNameTemplate` rendering of the key name (fallback `Group <id>`).

## Known Limitations and Deferred Work

- **No invariant surface**: this package publishes no `./invariant`. It has no owned relation whose independent observations can diverge — the sync is a settings write with the result readable back from the same service that accepted it.
- Mode A (panel login, 2FA, automatic key creation, group discovery) is Phase 2; until then groups are declared by hand (paste a key — that's all).
- The relay key cannot be reverse-mapped to its group: `/v1/sub2api/billing` and `/v1/usage` carry no group id/name/platform. The card never asks for a group id — the route name derives from the key's FNV-1a fingerprint (`sub2api-<fingerprint>`, idempotent re-add per key); the platform is guessed from the model list (manual override available); a subscription group's name is backfilled from `/v1/usage` `planName`.
- Capacity metadata (context window, max output, image input) follows the models.dev enrichment, with route-level defaults for ids the catalog does not know — expect generous defaults rather than exact figures for unmatched models.
- Usage lookup (`GET /v1/usage`) is a decided non-goal — consult the sub2api console.
- The panel API is a private frontend contract without a stability promise; responses are validated for required fields and fail loudly with context.
- Coexistence with the community plugin `GodD6366/dsh-sub2api`: route names do not collide (ours are `sub2api-<10-hex>` slugs, plus legacy `sub2api-<digits>` cleanup), but each plugin manages its own entries and credential refs — do not expect shared state.
- Requires a dsh release where `dsh-llm-pi-ai` attaches zero usage to replayed assistant messages (multi-turn pi-ai crash fixed on current master / the 0.1.2-rc.1 line).
- REAL composition, disposal, and snapshot tests against a live harness composition are pending; Phase 1 is verified by unit tests plus a live smoke test.

## Development

```sh
pnpm install
pnpm --filter @mangoc/dsh-sub2api-sync typecheck
pnpm --filter @mangoc/dsh-sub2api-sync test
pnpm --filter @mangoc/dsh-sub2api-sync build
```

MIT
