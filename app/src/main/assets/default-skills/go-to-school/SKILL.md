---
name: go-to-school
description: "Analyze recent activity and propose new skills, skill patches, or skill retirements. Triggered by /school command or phrases like 'go to school', 'run school', 'study time'. Challenges its own findings with a 5-gate rubric; surfaces rejections so the user can audit the thinking. Two-gate approval: /review N → YES N writes the file."
version: "1.0.0"
emoji: "🎓"
requires:
  bins: []
  env: []
allowed-tools:
  - school_begin
  - school_scan
  - school_write_skill
  - school_retire_skill
  - school_end
  - school_handle_input
  - file_read
  - file_write
  - telegram_send
---

# Go to School — Structured Self-Reflection

When the user invokes /school (or a natural-language trigger), you analyze your own recent behavior and propose concrete self-improvements. Your output is a ranked list of proposals, each passing a 5-gate rubric. The user approves per-proposal in two steps (/review N → YES N).

## Session flow

1. Call `school_begin({ reason: "on_demand" })`.
   - If `resumed: true`: you're picking up a prior session. Use `resumed_state` and continue in the state it's in.
   - Else: proceed to scanning.
2. Call `school_scan({ window_days: 7, min_repetition: 3 })`.
   - If `empty: true`: send one message "Not enough signal to propose anything — try again after more activity." and call `school_end` with empty summary. Stop.
3. Read memory files for context:
   - `file_read(MEMORY.md)` and the 7 most recent `memory/YYYY-MM-DD.md` daily notes.
4. Apply the rubric (below) to every candidate pattern from `school_scan`. Build proposals.
5. Apply the dedup gate against `prior_sessions` (also from `school_begin`).
6. Send the proposals message (format below) to the user via `telegram_send`.
7. For each user input, CLASSIFY it per the Input Classification Rubric. For school-relevant inputs, call `school_handle_input`. Execute the `next_action` it returns.
8. When all proposals are resolved (state=done), call `school_end` with the final summary.

## The rubric (5 gates)

Every candidate pattern must pass **all 5** before it's shown as a proposal.

| Gate | Type | Test |
|---|---|---|
| **Repetition** | Quantitative | `scan.repeated_patterns[i].count >= 3` (or failed/unused counts ≥ 3) |
| **Permanence** | Quantitative | `scan.repeated_patterns[i].spans_distinct_days >= 2` |
| **Gap** | Qualitative (requires artifact) | Produce a `coverage_check` block listing every existing tool/bundled-skill/workspace-skill considered and one line each on why it doesn't cover this pattern. No list → fail. |
| **Utility** | Qualitative (honest yes/no) | Answer yes/no with one sentence referencing scan data: "Will this skill fire often enough to earn its prompt-size cost?" FORBIDDEN: fake arithmetic. |
| **Actionable** | Structural | Draft the **When to Use** section inline, with concrete trigger keywords + specific tools + output format. If the draft reduces to "be smarter about X", fail. Soft-warning keyword check (`smarter`, `better`, `improved` without a concrete mechanism) flags for extra scrutiny. |

### Dedup gate (pre-rubric)

For each candidate, compute the signature `sha256(type + normalize(title))`. If it matches any entry in `prior_sessions` with `outcome` in `{drafted_but_denied, skipped, ignored, rejected_by_rubric, abandoned_stale, rejected_as_duplicate}` from the last 30 days, drop as `rejected_as_duplicate`.

## Proposal message format

Use HTML (Telegram). ≤ 4096 chars, chunked if longer.

```
🎓 School — <date> scan (last N days)

📝 CREATE  · <count>
🔧 PATCH   · <count>
🗑️ RETIRE  · <count>
❌ REJECTED · <count>

─── [1] CREATE · <slug> ───
Evidence: <evidence line>
Rubric: rep ✓ perm ✓ gap ✓ util ✓ action ✓ (5/5)
Confidence: N/10
Skeptical take: <one honest sentence>
> /review 1

... more proposals ...

─── Rejected (<count>) ───
· <slug> — fails <GATE>: <reason>
... more ...

Reply: /review N  |  /skip N  |  /stop
Reply on review: YES N  |  NO N  (bare YES/NO works if only one review open)
```

## Input Classification Rubric

An input is **school-relevant** iff it matches exactly one of:
- Starts with `/review ` + positive integer → `kind: "review"`, `proposal_n: <int>`
- Starts with `/skip ` + positive integer → `kind: "skip"`, `proposal_n: <int>`
- Equals `/stop` (exact, trimmed) → `kind: "stop"`
- Matches `^(YES|NO|Y|N|👍|👎)\s*(\d+)?\s*$` case-insensitive after trim (≤ 120 chars) → `kind: "yes"` or `"no"`, `proposal_n` optional
- Starts with `YES ` or `NO ` followed by number + non-empty trailing text → YES/NO captured, trailing text routed to normal handling in the same turn.

**Everything else is unrelated** — do NOT call `school_handle_input`. Route through normal message handling. If state is `reviewing_<N>`, append to your normal reply: *"Still awaiting YES/NO on proposal {N}."*

## Classification echo rule

After calling `school_handle_input` with a school-relevant input, the first sentence of your reply MUST echo back your classification — e.g. *"Understood as YES on proposal 3 — writing now."* or *"Taking that as /skip 2 — logged."*

This gives the user a visible correction hook. The state machine is deterministic from `school_handle_input` onwards, but input classification is still your judgment.

## Write-failure handling

If `next_action.kind` is `write_skill` or `retire_skill` and the follow-up tool call fails, do NOT proceed as if it succeeded. State stays at `reviewing_<N>`. Surface the error to the user: *"Couldn't write proposal {N}: {error}. Reply YES {N} to retry, NO {N} to decline, or /stop to end."* No log entry is written until the write succeeds or the user explicitly declines.

## Silent exit

If `school_scan` returns `empty: true` or all candidates fail the rubric + dedup, send one line — *"Not enough signal to propose anything — try again after more activity."* — and call `school_end` cleanly. No filler proposals.

## Post-approval note

Append to the success message after any write: *"Live on next turn."* — confirms no manual restart is needed; the existing `loadSkills()` live-read picks up new skills automatically.
