# @mangoc/dsh-sub2api-sync

Sync one [sub2api](https://github.com/Wei-Shaw/sub2api) instance's groups, keys, and models into [`dsh-llm-pi-ai`](https://github.com/deepseek-ai/deepseek-harness) provider routes: log in once, integrate automatically, keep syncing.

Design notes: [Phase 1 sync engine](../../../docs/design/2026-09-04-sub2api-provider-sync.md) and the [client UI revamp](../../../docs/design/2026-09-30-sub2api-sync-client-ui.zh.md) (Chinese; the current implementation baseline).

## Status: Mode A (panel-driven) + client UI

- **Sign-in channels**: panel password + 2FA (C3) is shipped; web authorization (C2, OAuth authorization code + PKCE) lands once sub2api deploys its OAuth endpoints. PAT (C1) was removed with this plugin — sub2api upstream never shipped the matching endpoint, so the channel has no token source;
- **Keys-driven sync**: the Keys card lists the panel's existing relay keys (none ticked by default) → **tick one or many** (cross-group) → "Sync selected" → **one key becomes one provider** (route `sub2api-<10-hex>`, no sequence id) → models are selectable on the next request; create new keys with the "Create key" dialog (defaulting to the group's name);
- **Provider naming**: rendered from `providerNameTemplate`, default `{siteName}({keyName})` — `<site name>(<key name>)`, the site name comes from instance probing;
- **UI**: the top-level settings card (`settings.section`), the plugin detail page's connect card and sync report (`plugins.detail.section`), and the plugin-page tuning card (`plugins.bundle.config`), styled after `ui-settings-account`, fully bilingual (zh/en);
- **Data seam**: configuration reads/writes go through the platform `configForms` (field-level, revision-fenced, schema-validated); host routes only carry actions, secrets, and status projections;
- The fingerprint routes (old Mode B) and group-driven sync (rev.5) are both retired — sync anchors real panel key ids.

## Install

### User install (release channels)

The harness loads the plugin through the package's `main`/`exports` entry — the **built** `lib/index.js`. Tarballs from any channel below ship `lib/` already; no local build needed:

**npm** — two names published in lockstep: same code, same version, the scoped name is canonical and the unscoped short name is an alias. Either installs:

```sh
dsh plugin --profile web add @mangoc/dsh-sub2api-sync   # canonical (scoped)
dsh plugin --profile web add dsh-sub2api-sync           # alias (unscoped short name)
```

**GitHub Releases tarball** (npm not involved; the URL always points to the latest release):

```sh
dsh plugin --profile web add https://github.com/Shuai-S/dsh-sub2api-sync/releases/latest/download/dsh-sub2api-sync.tgz
```

**From source** (pnpm runs the `prepare` build on git dependencies; needs a local toolchain, slower on first install):

```sh
dsh plugin --profile web add github:Shuai-S/dsh-sub2api-sync#path:packages/llm/sub2api-sync
```

After installing, restart the app or toggle the plugin off/on so the entry is imported again; a failed entry is not retried on its own.

### Release (maintainers)

Every release publishes **both names in lockstep** ([scripts/pack-all.mjs](scripts/pack-all.mjs)): one tarball for the scoped canonical name and one for the unscoped alias, sharing the same version. The plugin name embedded in the client bundle (mount key, detail-page matching, ModuleLoader id) and `cordis.patch.yml` are injected per package name at pack time, so both variants install independently. CI ([.github/workflows/release.yml](../../../.github/workflows/release.yml)) runs the whole flow: bump `version` in `packages/llm/sub2api-sync/package.json` → commit → `git tag vX.Y.Z && git push origin vX.Y.Z` → `pnpm check` → two tarballs → npm dual publish (requires the repo secret `NPM_TOKEN`; `publishConfig.registry` is pinned to the official npmjs registry, immune to mirror configs); the GitHub Release carries the short-name tarball asset. Manual dual publish from a local checkout:

```sh
pnpm pack:all    # emits both tarballs into dist/; repo files restored afterwards
npm publish dist/mangoc-dsh-sub2api-sync-*.tgz --registry=https://registry.npmjs.org --access public
npm publish dist/dsh-sub2api-sync-*.tgz --registry=https://registry.npmjs.org --access public
```

Publishing only the canonical package also works: `pnpm --filter @mangoc/dsh-sub2api-sync publish`.

### Local development (linked checkout)

`dsh plugin add` only symlinks a local directory (`link:`); it does **not** install dependencies or build the target, so building first is a hard precondition — not a development-time optional step:

```sh
pnpm install          # installs deps (runs the `prepare` build)
pnpm build            # tsdown + client wrapper; emits lib/index.js and lib/client.js
dsh plugin --profile web add ./packages/llm/sub2api-sync
```

After rebuilding, restart the app or toggle the plugin off/on so the entry is imported again; a failed entry is not retried on its own.

## Usage

1. Click **Connect panel** (from the settings card or the detail page's connect card), fill the **instance URL** (e.g. `https://cn.api.nexarelay.com`, optionally with `/v1`) plus credentials (panel email/password; TOTP accounts enter the one-time code when prompted; the password is stored in the credential store, so later sign-ins need no retyping);
2. The **Keys card** lists the instance's relay keys (newest first, 5 per page, "Load more" at the bottom). The checkbox in front of each row selects it for sync; "**Create key**" in the corner opens a dialog: pick a group → the name defaults to the group's name → the new key is ticked automatically;
3. Tick the keys to use (multi-select, cross-group) and hit "**Sync selected (N)**" — the engine builds **one provider per ticked key**, discovers models, maps the wire protocol from the owning group's platform (anthropic → anthropic-messages, the OpenAI family → openai-responses, the rest → openai-completions, overridable per group), and writes them into `llm-pi-ai.providers`;
4. Models are selectable on the next request. The "Sync" block at the bottom of the main card also triggers a full sync and shows the complete report; every report entry carries a "**Remove**" button — local routes and credentials only (**no panel calls**, works even with an empty balance) — and unticks the key so the next sync cannot resurrect it; the optional tuning fields live on the **Plugins page → Sub2API Sync** config card.

## dsh-Go (Android) adaptation

The plugin adapts to [DSH Go](https://github.com/ccch1mneyyy/dsh-Go)'s native settings capabilities (native protocol v1):

- **Native settings page** (Settings › Plugins › Sub2API Sync): every field applies instantly (volatile) with bilingual descriptions; the engine-maintained `routeKeyIds` map is hidden natively and advanced groups (retry policy and the like) start collapsed; the **panel password** is a credential slot (`DSH_SUB2API_PANEL_PASSWORD`) — set it from the phone and both the web card and the native panel sign in without retyping (the per-instance ref wins; this slot is the fallback);
- **Native surfaces**: a status strip above the input (routes · last sync) and a **Sync status** panel (chat details › Plugins tab): sign-in state, instance, route list, and **Sync now / Sign in / Sign out** actions; long actions run in the background and refresh on settle, failures show in the panel's callout. Requires the dsh-go bridge on the host (bundled with dsh-Go's local engine; remote hosts usually lack it, and nothing shows over DSH Remote);
- **Web island**: the full settings card works in dsh-Go's web mode. Over DSH Remote the plugin's action routes are not relayed — the card shows an "action routes unreachable" banner; sign in and sync from the desktop DSH Web instead;
- Two-factor (TOTP) accounts finish only the first leg natively; complete the second leg in the web settings card.

## Security

- All secrets (panel tokens, passwords, relay keys) live only in the harness credential store (deterministic refs `DSH_SUB2API_TOKEN_<instance hash>`, `DSH_SUB2API_KEY_<key-id>`, `DSH_SUB2API_PASSWORD_<instance hash>`, and the dsh-Go native slot `DSH_SUB2API_PANEL_PASSWORD`); never in settings, logs, or sessions;
- `GET /keys` returns only key metadata (id/name/group/status), **never plaintext**; plaintext is used by the engine to resolve that key and write it into the credential store immediately;
- Host action routes accept loopback same-origin requests only; over cross-device web access the configuration is read-only (platform `memory` mode) and actions require `allowRemoteActions` in `cordis.yml` (off by default).

## What a sync does

For every ticked key, the engine (idempotent diff + single-flight + optimistic concurrency):

1. resolves the key's plaintext (from the panel list when it returns it, otherwise the credential store: the new-style `DSH_SUB2API_KEY_<10-hex>` ref first, then the legacy `DSH_SUB2API_KEY_<key-id>` migration fallback, finally the OAuth reveal endpoint), keeping the credential consistent with the panel;
2. calls `GET {instance}/v1/models` with that key (falling back to `modelListOverrides` on failure);
3. maps the **owning group's** `platform` onto a wire protocol and derives the entry `baseURL` (the Anthropic SDK gets the bare host, OpenAI-family SDKs get the `/v1` root);
4. writes `providers.sub2api-<10-hex>` through a targeted `settings.mutate` carrying `expectedRevision`, with a lenient retry policy (5 retries / 120 s backoff cap).

The route suffix is a **10-hex-digit truncation of SHA-256(instance URL, key id)** — stable, collision-free across instances, and **deliberately free of the panel's sequential key id**: the route name leaks nothing about how many keys the site has issued, and a shared config screenshot reveals nothing either. Entries only ever cover the `sub2api-<10-hex>` (current) and `sub2api-<digits>` (legacy, migrated away on the next sync) shapes (**one key, one provider**; the display name is the key name rendered from `providerNameTemplate`). Keys that disappear from the selection lose their entry and credential; the remote key is only revoked when `deleteOrphanKeys` is enabled (the key id is reverse-mapped from the panel key list; legacy numeric routes carry their own). Sign-out, definitive auth loss, and instance switches **purge the plugin's sync state site-wide** — owned routes, relay-key credentials, and the **last sync report** go together (a report describing state that no longer exists must not keep rendering).

## Model Experience

- One provider per group, one relay key each; the model catalog comes from instance discovery; per-model `compat` inherits the user template; reasoning-effort templates win when explicitly set, otherwise they auto-fill per model (see below);
- **Model metadata enrichment (C4)**: at sync time, per-model facts are filled from the models.dev directory — **display name** (`name`, the model-catalog editor's display-name column), `contextWindow`, `maxTokens`, image input, reasoning efforts. With `enrichModelMeta` on (default) it fetches over the network (24 h in-process cache), falling back to the **bundled snapshot** (`data/models-dev.snapshot.json`, regenerate with `pnpm --filter @mangoc/dsh-sub2api-sync models:refresh`) on failure; off, only the bundled snapshot is used (offline-deterministic). Models hit by neither keep the route-level defaults 128000/8192/text-only;
- **Reasoning-effort auto-fill**: the models.dev entry's `reasoning_options` effort enumeration maps onto pi-ai's `reasoningEfforts` (`none` → `off: null`, same-name passthrough otherwise). Merging is **first-party first**: a vendor-official entry (openai/anthropic/google/zhipuai/zai/deepseek/moonshotai/xai/alibaba and vendor-governed cloud hosting) wins outright — official entries without effort data (budget-only older Claude/Gemini) likewise silence aggregator-invented vocabularies; with no first-party entry, aggregator sources intersect. Priority: **explicit template setting (including `false`) > per-model auto-fill > field left unset**; the display name is the key name rendered from `providerNameTemplate`.
- **Native Claude reasoning efforts**: for confirmed adaptive-thinking Claude models with catalog effort metadata (Opus 4.6/4.7/4.8, Sonnet 4.6 and the like), syncing over `anthropic-messages` also writes per-model `compat.forceAdaptiveThinking: true`. The switch makes the SDK send Claude's native `thinking: { type: "adaptive" }` and `output_config: { effort: "max" }` (Max selected as the example) — no OpenAI protocol bridge, no Max-to-token-budget downgrade. User-template compat values of the same name (including explicit `false`) win; disabled reasoning, legacy models, unknown aliases/new versions, missing catalog effort metadata, and other protocols never auto-enable it. Update the plugin and sync again to repair existing managed routes; repeated syncs write nothing twice; no sub2api record values change. Note: the usage log's effort is the request's declared effort, not a measurement of actual thinking.
- **Display-name enrichment**: the models.dev `name` lands on the pi-ai model entry's `name` field (what the model selector and the "customized model catalog" editor display); the models.dev " (latest)" family marker is stripped, names identical to the model id (no information) are not written, merging is first-party first (official names override, aggregator names fill absences), and name-only entries join the enrichment too.

## Known Limitations and Deferred Work

- **Masked panel plaintext**: if your panel account cannot see key plaintext (non-admin), sync fails and asks you to sign in with an admin account — a deliberate non-silent degradation.
- **No invariant surface**: this package publishes no `./invariant` (the sync is a settings write, verifiable by reading back from the same service).
- **Web authorization (C2) awaits sub2api's OAuth endpoint deployment** (design note §12); until then the UI hides the channel automatically.
- **dsh version floor: 0.2.0-rc.2** (the client half depends on the `configForms`/locale services; 0.1.x-era apps fail loudly).
- **The client half allows baseline external modules only** (React / Cordis / ui-primitives / ui-slots / client-store / ui-dockkit) — client code must not value-import `config.ts` (it would drag schemastery into the browser bundle; the dynamic module table has no such row and loading fails silently); `test/client-bundle.test.ts` guards the artifact.
- Behind Cloudflare, the zone must allow the host-side calls to `/api/v1/*` (a WAF skip rule).
- Metadata enrichment sends one public catalog request to models.dev (no credentials, no conversation content); `enrichModelMeta: false` goes fully offline (bundled snapshot only).
- Reasoning-effort auto-fill covers only models whose models.dev entry provides an `effort` enumeration (OpenAI gpt-5 line/o3, GLM 5.x, Qwen3.8, DeepSeek V4 line, and the like); toggle/`budget_tokens`-style reasoning (older Claude, Gemini, deepseek-v3.2, kimi-k2.x) has no effort-string wire shape, `reasoningEfforts` cannot express it, and the template/`compat` stays in charge.
- Usage lookup (`GET /v1/usage`) is a decided non-goal.
- Coexistence with the community plugin `GodD6366/dsh-sub2api`: route names do not collide (this plugin's `sub2api-<10-hex>` digest shape), and each plugin manages its own entries and credential refs.
- **The panel API is a private frontend contract** with no stability promise; responses are validated for required fields and fail loudly with context.
- **Requires a dsh release where `dsh-llm-pi-ai` attaches zero usage to replayed assistant messages** (the multi-turn pi-ai crash is fixed on current master / the 0.1.2-rc.1 line).
- **REAL composition, disposal, and snapshot tests against a live harness composition are pending**; current verification is unit tests plus a live smoke test.

## Development

```sh
pnpm install
pnpm --filter @mangoc/dsh-sub2api-sync typecheck
pnpm --filter @mangoc/dsh-sub2api-sync test
pnpm --filter @mangoc/dsh-sub2api-sync build
```

MIT
