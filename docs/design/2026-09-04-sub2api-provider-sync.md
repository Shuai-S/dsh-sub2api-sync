# Agent Note: sub2api provider sync plugin

Status: proposed

English | [中文](2026-09-04-sub2api-provider-sync.zh.md)

## Problem

[sub2api](https://github.com/Wei-Shaw/sub2api) aggregates Claude, OpenAI, Gemini, Grok, and other subscriptions (nine platform groups today: anthropic, openai, gemini, antigravity, grok, kimi, zhipu, deepseek, composite) behind one OpenAI/Anthropic-compatible gateway; self-hosted and shared ("pinche") deployments are common. Wiring it into this harness today is manual: log into the sub2api console to create a key, then add a custom provider by hand under Settings → Models in the Web UI and enter each model; repeat the whole flow whenever groups or models change (see the [providers guide](../../../../docs/user/guide/providers.md)). For shared instances exposing several groups, the repetition is worse. There is no "log in once, integrate automatically, keep syncing" path.

## Proposal

Add the single-purpose plugin `@deepseek-ai/dsh-sub2api-sync` (`packages/llm/sub2api-sync/`, following the [new-package checklist](../../../../docs/cookbook/adding-a-package.md)): it syncs one sub2api instance's groups, keys, and models into [`llm-pi-ai`](../../../../packages/llm/llm-pi-ai/README.md) provider routes. All behavior goes through existing extension points; the agent loop and `llm-pi-ai` stay untouched.

Four components inside one package, with no capability-seam split (single-purpose plugin; no third consumer for a replaceable role):

| Component | Responsibility |
|---|---|
| `Sub2apiClient` | Pure HTTP client over the panel API and gateway API; no DSH dependencies, unit-testable in isolation |
| `SyncEngine` | Diffs this plugin's entries in the settings user layer against remote group state and produces a minimal write plan |
| `CredentialManager` | Stores panel JWTs and per-group relay keys through `ctx.credentials`; settings keep only credential references |
| Surfaces | A settings card (configuration and triggering, [adding-a-settings-card](../../../../docs/cookbook/adding-a-settings-card.md)) and the `sub2api_sync` tool ([adding-a-tool](../../../../docs/cookbook/adding-a-tool.md)) |

Data flow: log in → `GET /groups/available` → ensure one relay key per selected group → `GET /v1/models` → compute target entries → `ctx.settings.mutate('llm-pi-ai', …)` → routes take effect on the next request (`llm-pi-ai` registers its route set from settings at runtime).

### sub2api panel API contract

The following endpoints are verified verbatim against sub2api source (`backend/internal/server/router.go`, `routes/auth.go`, `routes/user.go`, `routes/gateway.go`, `handler/auth_handler.go`, `handler/api_key_handler.go`). The panel API authenticates with `Authorization: Bearer <access_token>`; the gateway authenticates with the relay key.

| Endpoint | Method | Contract |
|---|---|---|
| `/api/v1/auth/login` | POST | `{email, password, turnstile_token?, tencent_captcha_ticket?, tencent_captcha_randstr?}` → `{access_token, refresh_token?, expires_in?, token_type, user}`; when the account enables TOTP the response is instead `{requires_2fa: true, temp_token, user_email_masked}` (discriminator field) |
| `/api/v1/auth/login/2fa` | POST | `{temp_token, totp_code}` (6 digits) → same success shape as login; `temp_token` is time-limited — expiry fails loudly and restarts the login |
| `/api/v1/auth/refresh` | POST | `{refresh_token}` → `{access_token, refresh_token, expires_in, token_type}`; rejected for non-admins when the instance enables backend mode |
| `/api/v1/keys` | GET/POST | List/create relay keys; List supports `page`/`page_size`/`sort_by`/`sort_order` plus `search`/`status`/`group_id` filters, answering `data.items/total/...`; `CreateAPIKeyRequest = {name*, group_id?, custom_key?, ip_whitelist?, ip_blacklist?, quota?, expires_in_days?, rate_limit_5h/1d/7d?}` |
| `/api/v1/keys/:id` | GET/PUT/DELETE | Read/update/delete one key |
| `/api/v1/groups/available` | GET | Groups the current user can bind; elements carry `id` (int64)/`name`/`platform`/`status`/`rate_multiplier` |
| `/api/v1/groups/rates` | GET | Per-group rates |
| `{instance}/v1/models` | GET | Gateway model discovery (relay-key auth) → `{"object":"list","data":[…]}`; most platforms answer elements shaped `{id, display_name, …}`, the grok platform differs — the client reads "take the id, tolerate the rest" |
| `{instance}/v1/chat/completions`, `/v1/messages`, `/v1/responses` | POST | The OpenAI / Anthropic / Responses wire protocols; the gateway dispatches automatically by the key's group platform |

Panel API envelope: success is `{code: 0, message: "success", data: <payload>}`, paginated endpoints answer `data = {items, total, page, page_size, pages}`; errors carry `code/message/reason?/metadata?`. `Sub2apiClient` unwraps the envelope and validates required fields; a missing or reshaped field fails loudly with the instance version attached.

Group ids are int64: values beyond `Number.MAX_SAFE_INTEGER` fail loudly (never silently truncated).

The full platform set (`backend/internal/domain/constants.go`) is nine: `anthropic`, `openai`, `gemini`, `antigravity`, `grok`, `kimi`, `zhipu`, `deepseek`, `composite`.

### Group → provider-entry mapping

- The provider id is fixed at `sub2api-<group-id>` (numeric ids are stable; groups can be renamed, so names are not identifiers). The display name is the group name.
- `baseURL` is derived per protocol (spelling validated by the reference implementation): `openai-completions` / `openai-responses` → `{instance}/v1`; `anthropic-messages` → bare `{instance}` (the Anthropic SDK appends `/v1/messages` itself; a `/v1` root would produce `/v1/v1/messages` and 404).
- `api` maps from the group platform (`supportedProtocols()` currently returns `openai-completions`, `openai-responses`, `anthropic-messages`). The mapping follows the gateway source (`routes/gateway.go`, `isOpenAIResponsesCompatibleGatewayPlatform`):

  | Group platform | `api` protocol | Rationale |
  |---|---|---|
  | `anthropic` | `anthropic-messages` | the gateway forwards `/v1/messages` natively |
  | `openai` / `grok` / `kimi` / `zhipu` / `deepseek` | `openai-responses` | the gateway forwards the Responses API natively through its OpenAI gateway for these five platforms; speaking the native protocol avoids the chat/completions bridging that drops parallel tool calls |
  | `gemini` / `antigravity` / `composite` | `openai-completions` | only bridged paths exist at the gateway |
  | other/unknown platforms | loud skip | the error names the platform; remaining groups are unaffected |

  `protocolOverrides` can force a per-group mapping.
- Model list: first call `GET /v1/models` with that group's relay key; when unavailable, fall back to the user-maintained list in Config. Model metadata (`contextWindow`/`maxTokens`/`reasoningEfforts`/image input) is enriched from [models.dev](https://models.dev/) by the plugin host during sync from Phase 2 on (in-memory cache 24h; a failed fetch only degrades to the Config template/empty — never a sync failure, and `enrichModelMeta` turns it off). Per-model `compat`/`reasoningEfforts` inherit a user template from Config so known reasoning-gateway differences can be preset (for example `supportsDeveloperRole: false`).
- One relay key per group, named `dsh:<provider-id>`; sync looks the name up via `GET /api/v1/keys?search=<name>&group_id=<gid>` plus an exact client-side name match, reuses an existing key (idempotent), and creates one only when absent. `quota` and `expires_in_days` come from Config and default to unset. If the local credential is missing at reuse time, the `key` field of the List response backfills the credential (backfill only; never logged or echoed into sessions).
- Generated entries carry a lenient default `retryPolicy` (`maxRetries: 5`, `retryableCodes` including `RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/EMPTY_RESPONSE`, backoff capped at 120s) — sub2api proxies upstream rate limits, and llm-pi-ai's default normal policy (2 retries / 10s) cannot outlast an upstream throttling window.
- Entry ownership: only the `sub2api-<digits>` shape. That shape is the boundary of what the plugin writes and cleans up; tightening to a numeric suffix also avoids clobbering the community plugin's routes (`sub2api-openai` etc., written by GodD6366/dsh-sub2api).

### Sync engine

- Idempotent diff: target state (remote groups + keys + models) against current state (settings user-layer `sub2api-<digits>` entries + credentials) produces a minimal `set` / `unset` / no-op plan. Emission rule: only a group with both a relay key and a non-empty model list yields an entry — llm-pi-ai's hand-declared routes need a non-empty `models` list, and a keyless route would surface as an unauthenticated route.
- Scoped writes: `ctx.settings.mutate('llm-pi-ai', ops)` touches only its own keys by path `providers.sub2api-<gid>`; user-configured entries (anything outside the `sub2api-<digits>` shape) are never touched. `llm-pi-ai` validates at the write site with `assertServiceable` (schema + serviceability) and rejects an invalid section with `settings-rejected`, keeping the last good section — part of failing loudly, never swallowed.
- Optimistic concurrency: writes carry `expectedRevision` (from `describe()`); on `SettingsConflictError` the engine re-reads (also invalidating its cached revision via `settings/document-updated`), recomputes, and retries (up to 3 times), then fails leaving both states intact for a human.
- Single flight: at most one sync runs at a time; the settings-card button, the `sub2api_sync` tool, and the timer share one queue.
- Deletion semantics: a group that disappears remotely or gets deselected → `unset` its provider entry and `unset` its credential; whether the remote key is revoked is decided by Config `deleteOrphanKeys` (default false).
- Scheduled resync: optional Config `syncIntervalMs`; enabled only when a writable settings provider is mounted, otherwise skipped and surfaced in the status area.

### Credentials and security

- Every secret goes through `ctx.credentials.set(ref, value)` / `unset(ref)` into [`dsh-credentials-local`](../../../../packages/credentials/credentials-local/README.md)'s `.credentials.yaml`; entries in `settings.yaml` keep only the `apiKeyEnv` credential reference (same pattern as the user's existing `SZZZ_API_KEY`).
- Deterministic ref naming: relay keys use `DSH_SUB2API_KEY_<group-id>`, panel tokens use `DSH_SUB2API_TOKEN_<instance-hash>`; the rules go into the package README.
- The account password is read from credentials only at login time and never enters settings, logs, or session context; error messages carry only the instance and group id.
- The plugin's HTTP calls are its own behavior, not a model-facing general-purpose network tool; the only model-triggerable action is the explicit `sub2api_sync` tool.

### Login modes and fallback

- Mode A (full auto): Config stores instance + email, the password lives in credentials; `login` → when the response carries `requires_2fa: true`, continue through `/auth/login/2fa` (`temp_token` + a 6-digit TOTP code entered once by the user in the settings card and never stored; a wrong code can be retried, an expired `temp_token` restarts the login), and refresh the access token through `/auth/refresh` when needed.
- Fallback trigger: on instances with Turnstile/TCaptcha enabled, the plugin does not solve captchas — it fails loudly and points to Mode B.
- Mode B (key-first): the user pastes an existing relay key for one group in the settings card, skipping the panel API; the model list comes from `GET /v1/models`, producing a single-group entry. Phase 1 delivers Mode B only.
- 401: concurrent requests share one single-flight `refresh`; retry once after it, and a further 401 marks the login state stale and waits for re-login, with no retry storm.

### Config

The plugin's own settings namespace is `sub2api-sync` — deliberately avoiding the `llm-*` prefix so the card lands in the Web settings page's plugin tab (`llm-*` namespaces belong to the Models page); the browser-side card pairs with it by namespace key. Since dsh 0.1.7 there is no registration call at all: the exported `Config` schema is auto-projected into the settings page, and every top-level field is marked `volatile`, so the entry's resolved config is the live source — the host swaps cell values in place on each form write (no remount) and announces them via `loader/volatile-update`, which is where cross-field validation now runs (a write persists first; an invalid value fails loudly instead of being refused at the write site).

Every field is validated and changeable from cordis.yml (per the root [AGENTS.md](../../../../AGENTS.md) rule against hardcoded tunables):

| Field | Type | Meaning |
|---|---|---|
| `baseURL` | string (URL-validated) | sub2api instance address |
| `email` | string | Panel account (Mode A) |
| `enabledGroups` | `number[]` | Group allowlist; default syncs all available groups. Group ids are int64; values beyond `Number.MAX_SAFE_INTEGER` are rejected at write time |
| `protocolOverrides` | `Record<groupId, 'openai-completions' \| 'openai-responses' \| 'anthropic-messages'>` | Force a per-group pi-ai protocol over the platform default; empty by default |
| `modelListOverrides` | `Record<groupId, string[]>` | Manual models when `/v1/models` is unavailable |
| `enrichModelMeta` | boolean (default true, Phase 2) | Whether to enrich model metadata from models.dev |
| `compatTemplate` | object | Per-model inherited compat/reasoningEfforts template |
| `keyQuota` / `keyExpiresInDays` | number? | Optional limits for created keys |
| `deleteOrphanKeys` | boolean (default false) | Whether removal also revokes the remote key |
| `syncIntervalMs` | number? | Scheduled resync interval; off by default |

Single-instance shape: upgrade to a list only when multi-instance demand appears (no current evidence; do not preset it).

### Tool surface

`sub2api_sync` (`defineTool`): parameters `{ groups?: number[] }`, defaulting to all enabled groups; returns a structured summary (added/updated/removed provider entries, per-group model counts, errors). The description is model-facing: "Sync the user's sub2api groups, keys, and models into the model providers."

Non-goal (decided): usage lookup (`GET /v1/usage`) is out of scope — keep the single purpose; consult the sub2api console for usage.

### Failure paths

Unreachable instance, rejected login, captcha challenge, group platform with no mapping, group id beyond the safe-integer range, schema rejection, revision conflict, failed model discovery — each produces a readable error carrying instance/group context. A failed models.dev fetch is a degradation, not a failure path. A single `mutate` validates the whole candidate and commits once, never leaving a half-applied state; failure keeps the last good state.

### Testing plan

- Unit: `Sub2apiClient` (injected fetch + local mock instance; covering envelope unwrapping, the `requires_2fa` discriminator, paginated lookup, int64 bounds), platform→protocol mapping and `protocolOverrides`, diff engine (given remote and current states → expected op sequence), ref naming, models.dev enrichment (mock data + failure degradation), `retryPolicy` pass-through.
- REAL composition (required by the [testing policy](../../../../docs/testing.md) for product-visible plugins): a test-only `cordis.yml` composing `dsh-settings-file` + `dsh-llm-pi-ai` + this plugin, asserting entries persisted to `settings.yaml`, routes reachable in the registry, and tool results against a local mock sub2api server.
- HMR/disposal: after disposing the fiber, the tool, namespace, and timer are all removed with no leftover writes.
- Snapshots: tool results and the settings-card descriptor (redacted).

### Rollout phases

1. Phase 1 (key-first): the gateway half of `Sub2apiClient` + single-group entry generation (including per-protocol baseURL and the `retryPolicy`) + scoped settings writes + a minimal settings card. Acceptance = AC1.
2. Phase 2 (full auto): panel login/2FA/refresh, key assurance, all-group sync, `protocolOverrides`, models.dev metadata enrichment, timer, and the tool surface. Acceptance = AC2–AC5.
3. Phase 3 (optional): remote key revocation, multi-instance.

## Alternatives considered

1. Keep manual configuration — rejected by the problem itself: the repetition and error-proneness are the motivation.
2. An MCP server — MCP contributes tools only; it cannot write `llm-pi-ai` provider configuration or credentials, so it cannot deliver "automatic integration".
3. A standalone CLI that generates a settings snippet to paste — no runtime integration, no UI, goes stale.
4. Teaching `dsh-llm-pi-ai` native sub2api awareness — pushes one community gateway's knowledge into the general adapter and pollutes the capability seam; provider configuration is already the extension point.
5. One entry per instance without group granularity — loses group isolation (rates, quotas, and platform protocols all differ per group); the group is sub2api's unit of resource.
6. Adopt the existing community plugin [GodD6366/dsh-sub2api](https://github.com/GodD6366/dsh-sub2api) — it addresses the manual per-platform entry experience: four fixed platform routes (`sub2api-openai` etc.), hand-pasted keys, settings-page model discovery and vision tools; it does no panel login, group discovery, or continuous sync, and it once needed an on-disk patch of the dsh install to work around a pi-ai multi-turn crash on older dsh (fixed on current dsh master, where `llm-pi-ai` attaches zero usage). This design differs in goal (automatic per-group sync vs manual per-platform entry); after tightening ownership to `sub2api-<digits>` the route names do not collide either, and its implementation findings (protocol choice, baseURL spelling, retryPolicy, emission rule) are absorbed here.

## Acceptance criteria

1. Mode B: after pasting a key and selecting a group, `settings.yaml` contains the correct provider entry, models come from that instance, and the Web UI model picker offers them with working conversations.
2. Mode A: after email/password login the groups are listed; selecting groups creates keys (reusing same-named ones) and generates one entry per group; TOTP accounts complete login with the one-time code; captcha-enabled instances fail with a clear message pointing to Mode B.
3. Idempotence: two consecutive syncs — the second produces zero changes and creates zero keys.
4. Convergence: a group or model added remotely appears after sync; a removed group takes its entry and credential away; user-configured entries stay byte-identical throughout; a failed models.dev enrichment only degrades (the entry is still generated with template metadata) and never blocks sync.
5. Concurrency: under simultaneous GUI editing, an `expectedRevision` conflict never overwrites the other writer.
6. Loud failure: every failure path yields a readable error (with instance/group context) and no silent partial state.
7. Gates: REAL composition, disposal, unit, and snapshot tests green; this package appears in the [config catalog](../../../../docs/config-catalog.md); the README carries contract-shaped Model Experience and Known Limitations sections; the package publishes no `./invariant` and says why in its README (no owned relation whose independent observations can diverge).

## Risks

1. The panel API carries no stability promise — the largest risk. Mitigations: required-field validation, tolerant reading, loud failure; file an upstream issue to seek a minimal stability commitment. Knowingly given up: supporting the full panel surface; only groups, keys, and models are taken.
2. Instances with Turnstile/TCaptcha cannot be fully auto-logged-in — accepted degradation (Mode B).
3. `GET /v1/models` answers differ per platform group (the grok platform's element shape differs; a `client_version` query switches to the Codex manifest) — accepted: extract only the `id`, fall back to the manual list on failure.
4. The local exposure of a relay key matches existing provider keys (a credentials file readable only by the OS user); it never enters settings, logs, or sessions. The `key` plaintext in List responses is used only to backfill a missing local credential, likewise never logged or echoed.
5. "Reuse by same name" is now verified feasible: List supports `search`/`group_id` filters and the `APIKey` DTO carries `name` (and the `key` plaintext); the implementation still validates real responses against required fields.
6. The single-instance assumption is unvalidated — Config keeps the upgrade path; do not implement without evidence.
7. Coexistence with the community plugin GodD6366/dsh-sub2api — route names no longer collide thanks to the `sub2api-<digits>` tightening; but its `sub2api-openai` routes share the `llm-pi-ai` namespace with this plugin's entries, and the README must state that coexistence keeps each side's entries and credential refs separate.
8. The pi-ai multi-turn usage crash is fixed on dsh master (`llm-pi-ai` replay attaches zero usage to historical assistant messages); the README states the minimum dsh version, and this plugin does not ship the reference implementation's install-directory patch for older dsh.
