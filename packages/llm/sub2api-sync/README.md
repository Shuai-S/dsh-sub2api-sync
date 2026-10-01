# @deepseek-ai/dsh-sub2api-sync

Sync one [sub2api](https://github.com/Wei-Shaw/sub2api) instance's groups, keys, and models into [`dsh-llm-pi-ai`](https://github.com/deepseek-ai/deepseek-harness) provider routes: log in once, integrate automatically, keep syncing.

Design Agent Note: see [the design notes](../../../docs/design/2026-09-04-sub2api-provider-sync.md) and [Chinese version](../../../docs/design/2026-09-04-sub2api-provider-sync.zh.md).

## Status: Phase 1 (key-first, Mode B)

Phase 1 ships the key-first path: declare groups by hand in the settings card, paste each group's relay key, and sync. The panel-driven path (Mode A: email/password login, 2FA, automatic key creation, group discovery, models.dev metadata enrichment, scheduled resync, the `sub2api_sync` tool) lands in Phase 2.

## Install

```sh
dsh plugin --profile web add ./packages/llm/sub2api-sync
```

or from a published package once released:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-sub2api-sync
```

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
4. writes a hand-declared `llm-pi-ai` provider profile at `providers.sub2api-<group-id>` through a scoped `settings.mutate` carrying `expectedRevision` (three conflict-retry attempts), with a lenient retry policy (5 retries / 120 s backoff cap) tuned for proxied upstream 429 windows.

Routes take effect on the next request. Entries only ever cover the `sub2api-<digits>` shape — the ownership boundary. Anything else in `llm-pi-ai.providers` (your hand-entered routes, other plugins' routes) is never touched. Groups that disappear from the config lose their entry and their credential; the remote key itself is only revoked when `deleteOrphanKeys` is enabled (Phase 2 enforcement).

## Model Experience

- **Context blocks (short form)**: one provider per sub2api group, one relay key per provider, model catalog discovered from the instance; per-model `compat`/`reasoningEfforts` inherit the user template. Capacity fields (context window, max tokens) default to 128000/8192 at route level until the models.dev enrichment (Phase 2) fills real values; models are declared text-only until then.
- Model ids come verbatim from the instance; the display name is the group name (fallback `Group <id>`).

## Known Limitations and Deferred Work

- **No invariant surface**: this package publishes no `./invariant`. It has no owned relation whose independent observations can diverge — the sync is a settings write with the result readable back from the same service that accepted it.
- Mode A (panel login, 2FA, automatic key creation, group discovery) is Phase 2; until then groups are declared by hand (paste a key — that's all).
- The relay key cannot be reverse-mapped to its group: `/v1/sub2api/billing` and `/v1/usage` carry no group id/name/platform. The card never asks for a group id — the route name derives from the key's FNV-1a fingerprint (`sub2api-<fingerprint>`, idempotent re-add per key); the platform is guessed from the model list (manual override available); a subscription group's name is backfilled from `/v1/usage` `planName`.
- Capacity metadata (context window, max output, image input) is route-level default until Phase 2's models.dev enrichment; expect generous defaults rather than exact figures.
- Usage lookup (`GET /v1/usage`) is a decided non-goal — consult the sub2api console.
- The panel API is a private frontend contract without a stability promise; responses are validated for required fields and fail loudly with context.
- Coexistence with the community plugin `GodD6366/dsh-sub2api`: route names do not collide (ours are `sub2api-<digits>`), but each plugin manages its own entries and credential refs — do not expect shared state.
- Requires a dsh release where `dsh-llm-pi-ai` attaches zero usage to replayed assistant messages (multi-turn pi-ai crash fixed on current master / the 0.1.2-rc.1 line).
- REAL composition, disposal, and snapshot tests against a live harness composition are pending; Phase 1 is verified by unit tests plus a live smoke test.

## Development

```sh
pnpm install
pnpm --filter @deepseek-ai/dsh-sub2api-sync typecheck
pnpm --filter @deepseek-ai/dsh-sub2api-sync test
pnpm --filter @deepseek-ai/dsh-sub2api-sync build
```

MIT
