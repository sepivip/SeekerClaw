## Summary

Brief description of the changes.

## Changes

-

## Testing

- [ ] Tested on device / emulator
- [ ] Existing functionality still works
- [ ] New functionality works as expected

## Self-Awareness Checklist

<!--
Check exactly ONE box. See CLAUDE.md §"Agent Self-Awareness" + §"SAB Audit BEFORE Merge".

"User-visible AI capability" = anything a user could ask the agent about and
expect it to know — new tool, provider, channel, skill type, auth flow, screen
the agent points users at, new persisted data the agent can read.

"Self-awareness surfaces" = any of:
  - app/src/main/assets/nodejs-project/ai.js (esp. buildSystemBlocks())
  - app/src/main/assets/nodejs-project/DIAGNOSTICS.md
  - New log(..., 'ERROR') or log(..., 'WARN') sites in JS
-->

- [ ] **N/A** — this PR does not ship a user-visible AI capability and does not touch ai.js / DIAGNOSTICS.md / new JS error log sites
- [ ] **SAB-audited** — ran `/sab-audit` before merge; pre-fix score ≥ 95%; any gap fixes are included in this PR

**SAB audit version (if applicable):** v__

## Related Issues

Closes #
