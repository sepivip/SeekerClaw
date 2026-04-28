# Cross-Process State in SeekerClaw

> Source of truth for: any state that's read or written by **both** the
> main UI process AND the `:node` service process.

This document explains the cross-process state model introduced in
**BAT-512** (parent epic [BAT-511](https://linear.app/batcave/issue/BAT-511)),
when to use it, and when to use one of the older patterns instead.

---

## Why this exists

SeekerClaw runs in two Android processes:

- **Main UI process** — Compose screens, user interaction.
- **`:node` service process** — embedded Node.js runtime via
  nodejs-mobile, the agent runtime itself.

Most state is local to one process. But a growing class of state is
**shared**: configuration that the user edits in Settings, and that
the agent reads when making API calls / picking a model / connecting
to MCP servers / etc. SharedPreferences caches per-process — so when
process A writes, process B keeps its old cached value until something
forces a re-read. This is the bug class that bit BAT-509 (the
provider/model/authType cache regression caught during device test).

The pattern that keeps biting us: **every config field that's read on
both UI and `:node` sides has the same staleness bug.** MCP servers,
search provider, agent name, channel — all latent until they bite.
The full audit lives in [BAT-511](https://linear.app/batcave/issue/BAT-511).

`CrossProcessStore<T>` is the abstraction we now reach for instead of
SharedPreferences for this class of state.

---

## When to use what

| State shape | Use this | Why |
|---|---|---|
| Cross-process config (provider/model/authType, MCP servers, agent name, …) | **`CrossProcessStore<T>`** | Atomic file IPC + StateFlow + FileObserver = both processes always see the latest value |
| Single-process settings (UI preferences, theme toggle) | SharedPreferences | No cross-process reader, no staleness risk |
| Encrypted blobs (API keys, OAuth tokens) | KeystoreHelper-encrypted SharedPreferences (today). [BAT-516](https://linear.app/batcave/issue/BAT-516) will wrap a Keystore-backed encryption layer over `CrossProcessStore` | Today's encrypted prefs work because they barely change post-Setup; migration is sequenced last |
| Service status / uptime / counters | `ServiceState` (legacy file IPC) | Pre-dates `CrossProcessStore`; works, kept for now. Could be migrated later, out of scope here |
| Logs | `LogCollector` | Append-only stream, not a key/value store; FileObserver-driven (BAT-518) |
| One-shot signals (bridge token, owner_ids) | Hand-rolled file IPC (legacy) | Stable, low-frequency, not worth migrating |

**Default for any new shared field:** `CrossProcessStore<T>`.

---

## How `CrossProcessStore<T>` works

### Storage

A single JSON file under `context.filesDir`, e.g.
`runtime_state.json`. Format is whatever `kotlinx.serialization`
produces for the `@Serializable` value type. Both Kotlin and Node read
the same file.

### Atomic writes

```
write(value) →
  1. writeText to "<filename>.tmp"
  2. Files.move(tmp → <filename>, REPLACE_EXISTING, ATOMIC_MOVE)
     ← single-syscall atomic replace on ext4/F2FS (the filesystems
       Android uses); no delete-then-rename window where observers
       could briefly see the file absent
  3. update StateFlow
  4. broadcast ACTION_STORE_CHANGED with EXTRA_FILE_NAME
```

A reader can never observe a half-written file because the move is
atomic. Critically, there is **no DELETE-event window** —
`Files.move` with `REPLACE_EXISTING + ATOMIC_MOVE` replaces the target
in a single filesystem operation, so FileObserver sees a single
`MOVED_TO` (or `MODIFY`) transition, never a `DELETE` followed by a
`CREATE`. This was a real bug in the first cut of this class:
`tmpFile.renameTo(file)` with a `file.delete()` fallback opened a
window where the file was absent, FileObserver fired `DELETE`,
`reload()` published `initial`, and only the subsequent
`CREATE`/`MOVED_TO` restored the correct value — observers briefly
saw garbage. Files.move closes that window.

Concurrent writes from the same process serialize via an internal
`synchronized(writeLock)` block; cross-process concurrent writes are
last-writer-wins (filesystem move semantics).

The Node side (`cross-process-store.js`) uses an equivalent
`fs.writeFileSync(tmp) + fs.renameSync(tmp, file)` contract, so a
Node-side write is interchangeable with a Kotlin-side write from the
reader's perspective. (Node's renameSync is atomic on POSIX
filesystems, which is what Android uses.)

### Refresh strategy (two layered mechanisms)

1. **`FileObserver` (kernel-level inotify event)**

   When `:node` writes the file directly via `fs.writeFileSync` /
   `fs.renameSync`, the inotify event fires on the main UI process and
   triggers a synchronous re-read. Same BAT-518 pattern that drives
   `LogCollector` and `ServiceState`. No polling.

2. **Package-scoped `ACTION_STORE_CHANGED` broadcast**

   When a Kotlin-side writer in our package writes, the store
   additionally fires a broadcast carrying `EXTRA_FILE_NAME`. Other-
   process receivers filter on the file name and trigger a re-read.
   Faster than waiting for the file event in some edge cases (process
   boundary just after registration, races with restart windows).

Either mechanism alone is sufficient. Both layered = belt-and-
suspenders reliability. **`mtime` polling is explicitly NOT used** —
[Codex's review of BAT-511](https://linear.app/batcave/issue/BAT-511)
called this out. FileObserver is the reliable mechanism; polling was
the wrong instinct.

### API contract (Kotlin)

```kotlin
val store = CrossProcessStore(
    context = applicationContext,
    fileName = "runtime_state.json",
    serializer = RuntimeState.serializer(),
    initial = RuntimeState(provider = "anthropic", model = "claude-sonnet-4-6"),
)

// Synchronous read — cheap parse-on-call. Use for one-shot reads
// (e.g. inside a save action) without Flow.first() rituals.
val current = store.read()

// Atomic write. Updates StateFlow + fires broadcast.
store.write(current.copy(model = "claude-opus-4-7"))

// Reactive observation in Compose / coroutines.
val state by store.state.collectAsState()
```

### API contract (Node)

```javascript
const { createStore } = require('./cross-process-store');

const store = createStore(
    path.join(workDir, 'runtime_state.json'),
    { provider: 'anthropic', model: 'claude-sonnet-4-6' },
);

// Sync read — defaults if missing or malformed.
const current = store.read();

// Atomic write. Returns true on success.
store.write({ ...current, model: 'gpt-5.3' });
```

The Node side does not emit cross-process notifications — it doesn't
need to. Kotlin's `FileObserver` picks up the file change automatically.

### Defensive behaviour

- **File missing** → returns `initial` from `read()`. No throw.
- **Malformed JSON** → returns `initial`, logs a WARN. No throw.
- **Unknown JSON keys** → ignored (`ignoreUnknownKeys = true`). Forward-
  compatible: a future build that adds a field doesn't break the
  current build.
- **Concurrent same-process writes** → serialized via internal lock.
- **Tmp leaked after a kill mid-write** → harmless. The reader only
  ever opens the real path; the leaked `.tmp` accumulates clutter only
  until the next successful write replaces it.
- **Broadcast send fails** → logged at WARN, FileObserver still
  delivers the event. Non-fatal.

---

## What's NOT in scope of this abstraction

- **Encryption.** Sensitive fields stay in
  `KeystoreHelper`-backed SharedPreferences for now. [BAT-516](https://linear.app/batcave/issue/BAT-516)
  will revisit and wrap a Keystore-backed encryption layer.
- **Atomic multi-field updates across stores.** Each store is
  independent. If you need an atomic update spanning two stores,
  serialize them into a single `@Serializable` type and use one store
  rather than two.
- **History / audit trail.** The store is current-state only.
  Versioning lives in your `@Serializable` type if you need it.
- **Sync writes that block on durability (fsync).** Mobile usage
  doesn't justify the latency cost; if the device powers off mid-
  write, the worst case is the previous good version stays on disk.
  If a future use case needs fsync, layer it on top.

---

## Migration order (BAT-511 family)

Each migration is a separate ticket so each one ships small, reviewable,
and independently revertible.

| Ticket | Field(s) | Status |
|---|---|---|
| **BAT-512** | (this) — foundation only, no migrations | In progress / shipping |
| [BAT-513](https://linear.app/batcave/issue/BAT-513) | `provider` / `authType` / `model` (the original BAT-509 Part 1) | Backlog |
| [BAT-514](https://linear.app/batcave/issue/BAT-514) | MCP server config | Backlog |
| [BAT-515](https://linear.app/batcave/issue/BAT-515) | `searchProvider`, `agentName`, `channel`, autoStart toggles | Backlog |
| [BAT-516](https://linear.app/batcave/issue/BAT-516) | Encrypted credentials (Keystore-wrapped) | Backlog |
| [BAT-517](https://linear.app/batcave/issue/BAT-517) | Shared `model-registry.json` | Backlog |

**Rule of thumb when adding a new shared field:** start a new store
file, don't pile fields into an existing one. Single-responsibility
stores compose better than mega-blobs.

---

## Tests

- `CrossProcessStoreTest.kt` — JVM tests for the file I/O +
  serialization contract. Android-specific surfaces (FileObserver,
  BroadcastReceiver) are device-tested only, same convention as
  `LogCollectorTest` and `ServiceStateTest`.
- `cross-process-store.test.js` — Node parity tests for atomic
  write, defaults, malformed-JSON tolerance, defensive cleanup.
- Drift guards in both test files pin the structural shape so a
  future refactor can't silently break the contract.

---

## References

- [BAT-511](https://linear.app/batcave/issue/BAT-511) — parent epic, full audit of the bug class
- [BAT-512](https://linear.app/batcave/issue/BAT-512) — this ticket
- BAT-518 family — established the `FileObserver` over polling pattern this builds on
- `app/src/main/java/com/seekerclaw/app/util/CrossProcessStore.kt` — implementation
- `app/src/main/assets/nodejs-project/cross-process-store.js` — Node parity
