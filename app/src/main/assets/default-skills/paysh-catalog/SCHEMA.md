# paysh-catalog v2 schema

> Contract for catalog.json + unsupported.json shipped with the paysh-catalog skill.
> Introduced in BAT-761 (2026-05-16). Replaces v1 (BAT-699 → BAT-705).

## Why v2

v1 (BAT-699) was service-first: one entry per service. The BAT-706 full-catalog audit (384 parsed_ok endpoints across 19 services) made three v1 problems obvious:

1. **No upstream linkage** — entries didn't carry `{operator, slug, pay_md_path}` so we couldn't diff against pay.sh's manifest to detect drift.
2. **No freshness metadata** — we didn't know when each entry was last probed/captured.
3. **One-service-one-entry forced trade-offs** — wolframalpha has v1/result AND v2/llm-api; rentcast has 10 endpoints; stablecrypto has 105. v1 picked ONE per service.

v2 fixes all three by making catalog entries **per-endpoint** with a `service_id` grouping field, an `upstream_ref` link, and `verification` metadata.

## File layout

```
paysh-catalog/
├── SKILL.md                  # opt-in trigger gate, agent instructions (v2-aware)
├── SCHEMA.md                 # this file
├── catalog.json              # v2 — supported entries
├── unsupported.json          # v2 — known-but-not-usable entries
└── services/
    ├── *.md                  # one .md per service; sections per endpoint
    ├── wolfram-alpha.md      # contains /v1/result + /v2/llm-api sections
    ├── rentcast.md           # contains /markets + 4 other endpoint sections
    └── ...
```

**`doc_file` is the source of truth for filenames.** Each catalog entry's `doc_file` field is the exact path (relative to skill folder) to its markdown doc. **There's no auto-derived `services/<service-id>.md` convention** — filenames are chosen for readability (`wolfram-alpha.md` is friendlier than `wolframalpha.md`) and the agent always uses `entry.doc_file` to locate the doc, never reconstructs the path from `service_id`. Validation only checks that `doc_file` resolves to an existing file.

**One service doc, multiple endpoint entries.** A service that exposes N catalog-listed endpoints has ONE markdown file with N sub-sections (one per endpoint). The agent reads the one doc per call regardless of which endpoint it picked.

## catalog.json structure

```json
{
  "version": 2,
  "generated_at": "2026-05-16T14:00:00Z",
  "manifest_checked_at": "2026-05-16T14:00:00Z",
  "source": "BAT-761 migration from v1 + BAT-706 audit data",
  "entries": [ /* per-endpoint entry objects (see below) */ ]
}
```

| Top-level field | Type | Meaning |
|---|---|---|
| `version` | int | Schema version. Currently `2`. Absent field → v1, requires migration. v3+ readers accept any `version >= 2` and treat unknown fields as opaque (preserve on round-trip). |
| `generated_at` | ISO-8601 string | When this catalog.json file itself was written. Bumped on every regeneration (migrate script, --refresh, manual edits). |
| `manifest_checked_at` | ISO-8601 string | When `probe-catalog.js --drift --write-checked-at` last fetched and compared pay.sh's upstream manifest against our catalog. **Only bumps when the caller passes `--write-checked-at`** — bare `--drift` is a pure check (no file mutations) so the timestamp stays at the last persisted check. Distinct from generated_at: a regeneration without re-fetching upstream doesn't bump this. The result of the check (in-sync / drift detected) is computed at --status time from the entries; not stored separately. |
| `source` | string | One-line provenance — "BAT-761 migration", "BAT-706 audit", "manual edit 2026-06-15", etc. |
| `entries` | array | The actual catalog entries. |

## Entry object (per-endpoint)

```json
{
  "id": "wolfram-alpha-llm",
  "service_id": "wolframalpha",
  "name": "Wolfram Alpha (LLM API)",
  "upstream_ref": {
    "operator": "paysponge",
    "slug": "wolframalpha",
    "pay_md_path": "providers/paysponge/wolframalpha/PAY.md",
    "service_url": "https://wolframalpha.x402.paysponge.com"
  },
  "endpoint": {
    "method": "GET",
    "path": "/v2/llm-api",
    "cost_usdc": 0.02
  },
  "intents": ["complex math", "physics", "synthesized facts"],
  "summary": "Wolfram's LLM-optimized API — synthesized prose answers vs v1/result's raw computation.",
  "doc_file": "services/wolfram-alpha.md",
  "doc_anchor": "v2-llm-api",
  "verification": {
    "last_probed_at": "2026-05-16T11:13:50Z",
    "last_capture_path": "tests/paysh/captures/catalog/paysponge-wolframalpha-llm.json",
    "last_captured_at": "2026-05-16T11:13:50Z",
    "probe_status": "parsed_ok"
  }
}
```

### Required fields

| Field | Type | Meaning + rules |
|---|---|---|
| `id` | kebab-case string | **Globally unique across catalog.json AND unsupported.json** (the `--refresh <id>` command searches both). Used as the agent-facing entry handle. Convention: `<service_id>-<endpoint-slug>` (e.g. `wolfram-alpha-llm`) or just `<service_id>` if the service has one entry (e.g. `wolfram-alpha`, `textbelt-sms`). For services with nested slugs (e.g. `stablecrypto/market-data`), flatten via `-` in the id (e.g. `stablecrypto-market-data-price`). |
| `service_id` | kebab-case string | Groups entries from the same pay.sh service. Multiple entries can share a service_id (wolfram-alpha-v1 + wolfram-alpha-llm both have `service_id: "wolframalpha"`). For nested slugs flatten via `-` (e.g. `stablecrypto-market-data`). |
| `name` | string | Human-readable display name. May include endpoint clarifier ("Wolfram Alpha (LLM API)"). |
| `upstream_ref.operator` | string | pay.sh operator slug (e.g. `paysponge`, `merit-systems`, `crushrewards`). Always single-segment. |
| `upstream_ref.slug` | string | pay.sh service slug within the operator. **May contain `/`** for nested services (e.g. `wolframalpha`, `stablecrypto/market-data`, `stableenrich/enrichment`). Preserve nested form here — flattening only happens in `id`/`service_id`. |
| `upstream_ref.pay_md_path` | string | Relative path of the PAY.md in pay.sh's pay-skills repo. Always `providers/<operator>/<slug>/PAY.md` (e.g. `providers/merit-systems/stablecrypto/market-data/PAY.md`). Used by --drift to fetch the upstream source of truth. |
| `upstream_ref.service_url` | URL \| null | Base URL of the service (from PAY.md frontmatter). Combined with `endpoint.path` to build the probe URL. **MUST be a real URL for catalog.json entries** (every catalog entry has been probed and we have its service URL). **MAY be `null` for unsupported.json entries** — many unsupported services never reached a 402 in our probe runs, so we don't have a captured service URL. `probe-catalog.js --refresh <id>` backfills `service_url` from the PAY.md frontmatter (`disc.serviceUrl`) on successful refresh. |
| `endpoint.method` | enum | `GET` or `POST` only. `agent_pay` rejects other methods with `method_not_allowed`, so catalog/unsupported entries must be one of these two. (For informational sibling endpoints in `audit_pending[]` — see below — any HTTP method may appear since the audit reports what upstream exposes; only the curated `endpoint.method` is invocable.) |
| `endpoint.path` | URL path | Path on the service. Combined with `service_url` to form the full URL. |
| `endpoint.cost_usdc` | number | Per-call cost in USDC, **decimal** (e.g. `0.02` not `20000` atomic). Matches the agent-facing `max_usdc: "0.05"` convention. |
| `intents` | string[] | Keyword/phrase list the agent matches against user intent. Min 3, recommended 5-10. |
| `summary` | string | One-line description for catalog browsing ("what can you pay for"). |
| `doc_file` | string | Path (relative to skill folder) to the markdown file with full usage docs. The doc covers body schema, response shape, examples, and any safety scoping. |
| `verification.last_probed_at` | ISO-8601 | When `probe-catalog.js` last probed this endpoint (regardless of result — non-402, parser-rejected, or successful 402 all bump this on every probe attempt). Distinct from `last_captured_at`, which only bumps when probe_status is `parsed_ok` AND a fresh capture is written. |
| `verification.last_capture_path` | string \| null | Path to the JSON capture file. `null` for entries where the probe never reached HTTP 402 (e.g. `http_4xx`/`5xx` responses, `fetch_failed`, `unknown` status). **May be non-null for `reject:<reason>` entries** — the HTTP 402 succeeded so we have a capture, but the parser refused (mpp_protocol / siwx_auth_required / invalid_demand). |
| `verification.last_captured_at` | ISO-8601 \| null | When the capture file was written. `null` if `last_capture_path` is null. Distinct from `last_probed_at` — a probe that confirmed the existing capture is still valid bumps `last_probed_at` but not `last_captured_at`. |
| `verification.probe_status` | enum | Whatever `probeAndParse()` (or `--refresh`) last set. Possible values: `parsed_ok` (HTTP 402 + parser accepted), `reject:<reason>` (HTTP 402 + parser refused — `reject:mpp_protocol` / `reject:siwx_auth_required` / `reject:invalid_demand` / `reject:no_solana_offer` / `reject:invalid_402_body` / etc., matching probeAndParse's classification), `detect_false` (HTTP 402 received but proto.detect() returned false — body shape we don't recognize as x402), `fetch_failed` (no HTTP response — DNS/TLS/timeout), `http_<NNN>` (non-402 HTTP response), `unknown` (no capture and no recorded probe status — only valid for unsupported.json entries migrated from v1 without HTTP context). For catalog.json this MUST be `parsed_ok`. |

### Optional fields

| Field | Type | When to use |
|---|---|---|
| `doc_anchor` | kebab-case string | Markdown anchor within `doc_file` pointing to the endpoint-specific section. E.g. `v2-llm-api` → agent reads `services/wolfram-alpha.md#v2-llm-api`. Omit when the service has one entry (whole doc is the entry's section). |

## unsupported.json structure

Same top-level shape as catalog.json (`version`, `generated_at`, `manifest_checked_at`, `source`, `entries`) PLUS a top-level `reasons` registry the agent reads to explain each refusal reason to users:

```json
{
  "version": 2,
  "generated_at": "...",
  "manifest_checked_at": "...",
  "source": "...",
  "reasons": {
    "endpoint_not_402_at_probe": {
      "label": "Service exists in pay.sh's catalog but didn't return a 402 at probe time",
      "explanation": "Service is listed in pay.sh's upstream catalog but our probe got a non-402 HTTP status...",
      "actionable": false
    },
    "...": { /* one entry per reason bucket */ }
  },
  "entries": [ /* see below */ ]
}
```

### `reasons` registry

Top-level object. One key per reason bucket the catalog uses. Each value:

| Field | Type | Meaning |
|---|---|---|
| `label` | string | Short human-readable label for the reason (used in --status reports). |
| `explanation` | string (markdown) | Full agent-facing prose explaining the bucket — when the agent answers "why can't you use X?", it composes from this. |
| `actionable` | bool | `true` if there's a known path to fix (e.g. binary handler unblocks `requires_binary_response`), `false` if it's blocked indefinitely. Surfaces in --status. |

Six buckets in v2 (carried from v1 PR #378 R10 state):

| reason | Meaning | actionable |
|---|---|---|
| `mpp_protocol` | Service uses Multi-Party Protocol — we don't implement yet | false |
| `siwx_auth_required` | Service needs Sign-In-With-Solana auth before 402 | false |
| `invalid_demand` | Service returns 402 with amount=0; agent_pay refuses zero-demand | false |
| `requires_binary_response` | Service returns binary content we can't deliver to channels yet | true (BAT-764) |
| `endpoint_not_402_at_probe` | Probe got a non-402 status (4xx/5xx/200/301) — broken/moved/auth-gated | false (re-probe if upstream fixes) |
| `unverified_paid_response_shape` | Parses_ok but we haven't captured paid response; evidence about shape is contested | true (BAT-708 paid-response capture) |

### Unsupported entry object

```json
{
  "id": "paysponge-perplexity-catalog-url",
  "service_id": "perplexity",
  "name": "Perplexity (paysponge catalog URL)",
  "upstream_ref": { /* same as catalog.json */ },
  "endpoint": {
    "method": "GET",
    "path": "/",
    "cost_usdc": null
  },
  "reason": "endpoint_not_402_at_probe",
  "evidence_basis": "openapi-response-content-type",
  "verification": {
    "last_probed_at": "2026-05-16T11:13:50Z",
    "last_capture_path": null,
    "last_captured_at": null,
    "probe_status": "http_200"
  },
  "note": "Catalog-listed endpoint returned http_200 — non-402. Sibling endpoints found by BAT-706 audit: /search and /v1/agent catalogued in BAT-769; /v1/async/sonar remains in audit_pending below (unscheduled — needs async-fetch pattern).",
  "audit_pending": [
    { "method": "POST", "path": "/v1/async/sonar", "cost_usdc": 0.01, "deferred_to": null }
  ]
}
```

Required: same `id`/`service_id`/`name`/`upstream_ref`/`endpoint`/`verification` as catalog entries, **plus** `reason` (one of the six bucket keys above). `endpoint.cost_usdc` MAY be `null` for entries where probe never reached 402 (no cost observed).

### Optional fields on unsupported entries

| Field | Type | When to use |
|---|---|---|
| `evidence_basis` | enum | For `requires_binary_response` and `unverified_paid_response_shape` only. Values: `paid-response-observed` (settled + observed binary), `openapi-response-content-type` (openapi `responses` declares image/* / video/* / audio/* / application/octet-stream), `product-family-inference` (service's published product is image/video gen — weakest evidence, conservative refuse). Introduced PR #378 R10 — preserve from v1 migration. |
| `note` | string (markdown) | Free-form per-entry explanation. Useful for documenting specific HTTP error codes, audit findings, deferred BAT pointers. Distinct from the bucket-wide `reasons[<bucket>].explanation` — the note is entry-specific. |
| `audit_pending` | array | Lists sibling endpoints found by the BAT-706 audit that aren't catalogued. Each entry: `{method, path, cost_usdc, deferred_to: "BAT-XXX" \| null}`. `deferred_to` is a BAT ticket id when a follow-up exists, OR `null` when the endpoint is unscheduled (no ticket yet — we know it's there, but haven't decided when/how to catalog it). Empty array (or omitted) if the audit found no extras. As endpoints get promoted to catalog.json, drop them from this list. When a `null`-deferred endpoint gets a ticket, update its `deferred_to` to the ticket id. |

### Catalog ↔ unsupported lifecycle

When a paid endpoint gets promoted (via BAT-708 follow-ups, or BAT-764 unblocking a binary entry):

1. Remove the endpoint from the unsupported entry's `audit_pending` array
2. Add a new entry to `catalog.json` with the same `service_id` (different `id`)
3. If the unsupported entry's catalog-URL endpoint still fails (e.g. perplexity catalog URL is still `http_200`), the unsupported entry STAYS — the broken URL doesn't get "fixed" by promoting sibling endpoints
4. If the unsupported entry's catalog-URL ALSO becomes payable (rare), delete the unsupported entry entirely

Conversely, if a catalog entry stops working (drift detected, --refresh fails with non-parsed_ok), it migrates DOWN to unsupported with the new reason bucket.

## Drift detection (`probe-catalog.js --drift`)

Compares catalog vs pay.sh upstream:

1. Fetches the pay-skills GitHub tree (`https://api.github.com/repos/solana-foundation/pay-skills/git/trees/main?recursive=1`) to enumerate every `PAY.md` path upstream
2. Diffs against `catalog.json.entries[].upstream_ref.pay_md_path` ∪ `unsupported.json.entries[].upstream_ref.pay_md_path`
3. Reports:
   - **Added upstream** — `PAY.md` paths in pay.sh's tree not in either of our files (new services to catalog)
   - **Removed upstream** — entries in our files whose `pay_md_path` no longer exists upstream
   - **Stale captures** — entries with a real `last_captured_at` older than N days (default 30; never-captured entries are reported separately, not as "stale")
   - **Never captured** — entries with `last_captured_at: null` (informational, not drift)
4. **Pure check by default** — does NOT modify catalog.json/unsupported.json. Pass `--write-checked-at` to persist the `manifest_checked_at` bump (useful for scheduled runs that want the freshness signal recorded).
5. Exits 3 on drift (CI-friendly).
6. **Out of scope (future)**: per-service openapi endpoint drift (would require fetching every service's `openapi.json` and diffing against the catalog entries' endpoint paths — heavier; deferred to BAT-765 weekly CI job).

## Status report (`probe-catalog.js --status`)

Local-only — writes `tests/paysh/catalog-status.md` (does not network, does not modify catalog files):

- **Summary** — counts by bucket (catalog / unsupported / fresh / stale / no-capture / audit-pending)
- **Stale captures** — entries with `last_captured_at` older than 30 days; suggests `--refresh <id>`
- **Audit-pending siblings** — table of unsupported entries with `audit_pending[]` arrays, grouped by `service_id` with `deferred_to` BAT pointers

No "Drifted" section in `--status` itself — run `--drift` for that (it queries upstream). The status report does include `manifest_checked_at` so you can tell how stale the last drift check is.

## Refresh single entry (`probe-catalog.js --refresh <id>`)

1. Looks up entry by `id` in catalog.json or unsupported.json (global uniqueness makes this unambiguous)
2. Re-discovers the service via `discoverOne(upstream_ref.pay_md_path)` to get a fresh `service_url` from PAY.md frontmatter (handles the case where the stored `service_url` is null on unsupported entries)
3. Re-probes `serviceUrl + endpoint.path` with the entry's curated method
4. Updates `verification.last_probed_at` + `probe_status` always
5. If `probe_status === 'parsed_ok'`: sanitizes the response (same `sanitize()` helper used by `--commit-captures`) and writes a fresh capture to `last_capture_path`; bumps `last_captured_at`
6. Bumps `generated_at` on the containing file

## Mode mutual exclusion

`--audit`, `--drift`, `--status`, `--refresh` are mutually exclusive — passing more than one prints an error and exits 2. Standard probe mode (no mode flag) is the default.

## Migration from v1

A one-time `tests/paysh/migrate-v1-to-v2.js` script:
1. Detects v1 by absence of `version` field (or `version === 1`)
2. Reads v1 `catalog.json` (10 entries) + `unsupported.json` (62 entries)
3. Cross-references each v1 entry against `tests/paysh/captures/catalog/<file>.json` for upstream_ref + capture path
4. Cross-references `tests/paysh/catalog-audit.md` (BAT-706 output) for `audit_pending` lists
5. Preserves PR #378 R10 fields (`evidence_basis`, `note`)
6. Emits v2 `catalog.json` + `unsupported.json`
7. Runs programmatic validation: every entry has required fields, types match, ids are globally unique, no broken doc_file references

Script is idempotent — re-running produces the same output. Run once to migrate; thereafter use `--refresh` to update individual entries.

### Validation rules (enforced by migrate script)

- `version === 2`
- `entries[]` is array
- All required fields present on each entry
- `id` is kebab-case and globally unique across catalog.json + unsupported.json (the `--refresh <id>` command searches both files)
- `service_id` is kebab-case
- `upstream_ref.pay_md_path` matches the pattern `providers/<operator>/<slug>/PAY.md` where `<operator>` and `<slug>` match the corresponding fields
- `endpoint.cost_usdc` is non-negative number (catalog) or non-negative-or-null (unsupported)
- `verification.last_capture_path` and `last_captured_at` are null together (both null or both non-null) — they're a pair
- For catalog.json: `verification.probe_status === "parsed_ok"` for every entry, and `last_capture_path` must be non-null when so
- For unsupported.json: `reason` is one of the six registered bucket keys
- For unsupported.json: `reasons` object has an entry for every bucket key referenced in `entries[].reason`
- `doc_file` (catalog only) refers to a file that exists in `services/`

**Not validated** (informational, may relax over time):
- `service_id` ↔ `id` relationship — convention is `id = <service_id>` or `id = <service_id>-<endpoint-slug>`, but no enforcement (some legacy ids predate the convention)
- `last_capture_path` non-null for `reject:<reason>` entries — captures CAN exist for parser-rejected 402s (the HTTP layer succeeded, we have the body), but we don't require them; they're informational evidence

Validation failure aborts the migration run and prints which entry/field failed.

## Backwards compatibility

Existing user devices have v1 catalog files in `workspace/skills/paysh-catalog/`. The plan:

1. Bump `SKILL.md` frontmatter `version` on EVERY catalog-affecting change — triggers `ConfigManager.seedSkill()` re-seed per the BAT-699 R6 pattern. Version history: `1.3.0` (BAT-704 opt-in gate, last v1 schema) → `1.4.0` (BAT-761 v2 schema migration) → `1.5.0` (BAT-769 perplexity catalog entries) → bump again on the next catalog change (BAT-766, BAT-768, etc.). On every future catalog edit, bump the version so existing installs re-seed.
2. seedSkill uses the existing stage-then-swap atomicity (BAT-699 R7) to swap v1 → v2 files
3. User-added catalog entries (rare but possible) are preserved by the stage-then-swap merge logic
4. Agent in `SKILL.md` body explicitly handles v2 schema (no v1 readers in the agent — re-seed is mandatory)

## Forward compatibility

A v3 (if needed) would bump `version: 3`. v2 readers should:
- Accept any object with `version >= 2`
- Treat unknown fields as opaque (preserve on round-trip)
- Fail loudly on `version < 2` (don't try to back-port)
