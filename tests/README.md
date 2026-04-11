# Tests

Node-side tests for SeekerClaw's embedded `nodejs-project` bundle.

## Layout

```
tests/
├── README.md                          # this file
└── nodejs-project/
    ├── smoke.js                       # smoke test harness — run on every commit
    └── silent-reply.test.js           # unit tests for silent-reply.js
```

**Why `tests/` at the repo root:** anything under `app/src/main/assets/` is
packaged into the APK and extracted to the device at runtime. Tests should
live outside that tree so they're excluded from the shipped bundle. This
matches the Node / Mocha convention of `tests/` at the project root.

## Running

From the repo root:

```bash
# Fast smoke test — run before every commit that touches nodejs-project/
node tests/nodejs-project/smoke.js

# silent-reply unit tests
node tests/nodejs-project/silent-reply.test.js
```

Each script exits `0` on success, non-zero on failure. Expected runtime is
under 2 seconds.

## When to run

- **Before every commit that touches `app/src/main/assets/nodejs-project/**`**.
  This is the rule — the smoke test catches regex compile failures and other
  module-load crashes that `node --check` misses.
- **Before tagging any release candidate**. Even a clean smoke test isn't
  sufficient for a tag — always also install on the user's device and
  confirm the agent reaches `RUNNING` state. See the `never-tag-before-
  device-check` feedback memory in the global memory store.

## What the smoke test covers

### Phase 1 — `node --check` on every JS file

Runs the parser over all `.js` files under `nodejs-project/` (skipping
`node_modules/`). Catches syntax errors, unclosed braces, typos, and
similar lexical problems. Fast — typically under 1s for the whole bundle.

### Phase 2 — `require()` of side-effect-free modules

Actually loads a curated set of pure modules in a real Node process. This
is where constant regex compilation, schema validation, and other
module-init code runs. **This phase is what catches bugs like the one
that bit us in v1.9.0-rc5** — a `\p{L}\p{N}` Unicode property escape in
`silent-reply.js` that parsed fine on desktop Node 22 but crashed
nodejs-mobile's V8 when `new RegExp(...)` ran at module load.

The curated set lives in `smoke.js` as `LOAD_TARGETS`. To keep it
reliable, modules with real startup side effects (network connections,
timers, WASM load, `config.json` dependency) are deliberately excluded
and listed in `SKIP_REASONS` with explanations. Current set:

- `silent-reply.js` — SILENT_REPLY token handling
- `loop-detector.js` — tool-call loop detection

### Phase 3 — unaccounted-for files

Warns (but does not fail) when a `.js` file appears under `nodejs-project/`
that is neither in `LOAD_TARGETS` nor explicitly listed in `SKIP_REASONS`.
This forces new files to get deliberate test coverage or an explicit
"skipped because X" note. Ping the harness maintainer to decide.

## Why not more modules?

Most of the bundle depends transitively on `config.js`, which calls
`process.exit(1)` if required fields (bot token, API key, etc.) are
missing. To load those modules in the test environment we'd need to
synthesize a valid fixture `config.json` in a fake workdir, then use
`process.argv[2]` to point at it. That's a reasonable future improvement
(an "integration" phase alongside "unit" + "smoke") but it's not built
yet — the pure-module smoke coverage plus the unit tests are the
immediate priority.

## Unit tests

`silent-reply.test.js` runs 17 cases against `stripSilentReply()` and
`containsSilentReply()`, covering:

- Exact / standalone tokens (including case-insensitive, whitespace-padded)
- Leading-spaced form (`SILENT_REPLY hello`, `SILENT_REPLY\nhello`)
- Leading-glued form (`SILENT_REPLYhello`, `SILENT_REPLY_hello`)
- Mid-token placement and multi-token patterns
- Markdown-wrapped variants (`**SILENT_REPLY**`, `` `SILENT_REPLY` ``)
- JSON envelope form (`{"action":"SILENT_REPLY"}`)
- Identifier preservation (`MY_SILENT_REPLY_HANDLE` must NOT be stripped)
- Plain text passthrough

## Adding tests

- New unit test file: create `tests/nodejs-project/<module>.test.js`,
  follow the pattern in `silent-reply.test.js` (plain JS, no framework,
  exit 0 = pass, exit 1 = fail).
- New smoke coverage: add the file to `LOAD_TARGETS` in `smoke.js` if it's
  safe to `require()` from an empty workdir, or to `SKIP_REASONS` with a
  one-line explanation.
- Always run both `smoke.js` and relevant `*.test.js` files before
  committing.
