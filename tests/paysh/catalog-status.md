# paysh-catalog maintenance status

Generated: 2026-05-16T16:50:26.638Z
Catalog generated_at: 2026-05-16T16:49:12.912Z
Manifest last checked: 2026-05-16T16:49:12.912Z (run `node tests/paysh/probe-catalog.js --drift --write-checked-at` to refresh — bare `--drift` is a pure check and won't update this timestamp)
Freshness window: 30 days

## Summary

| Bucket | Count |
|--------|-------|
| Catalog entries | 9 |
| Unsupported entries | 63 |
| Fresh (capture ≤ 30d) | 51 |
| Stale (capture > 30d) | 0 |
| No capture (probe never reached 402) | 21 |
| Entries with audit_pending siblings | 10 |
| Total audit_pending sibling endpoints | 240 |

## Audit-pending siblings (queued for catalog promotion)

| service_id | pending count | deferred_to |
|---|---|---|
| `rpc` | 133 | (unscheduled) |
| `stablesocial-social-data` | 36 | (unscheduled) |
| `stableenrich-enrichment` | 32 | BAT-772 |
| `stableemail-email` | 11 | BAT-770 |
| `fal` | 9 | BAT-764 |
| `email` | 8 | (unscheduled) |
| `screenshotone` | 3 | BAT-764 |
| `perplexity` | 3 | BAT-769 |
| `stablephone-calls` | 3 | BAT-771 |
| `nyne` | 2 | BAT-772 |

