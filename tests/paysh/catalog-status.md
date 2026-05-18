# paysh-catalog maintenance status

Generated: 2026-05-18T12:45:00.666Z
Catalog generated_at: 2026-05-18T12:41:57.683Z
Manifest last checked: 2026-05-16T17:51:08.251Z (run `node tests/paysh/probe-catalog.js --drift --write-checked-at` to refresh — bare `--drift` is a pure check and won't update this timestamp)
Freshness window: 30 days

## Summary

| Bucket | Count |
|--------|-------|
| Catalog entries | 44 |
| Unsupported entries | 63 |
| Fresh (capture ≤ 30d) | 86 |
| Stale (capture > 30d) | 0 |
| No capture (probe never reached 402) | 21 |
| Entries with audit_pending siblings | 10 |
| Total audit_pending sibling endpoints | 238 |

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
| `stablephone-calls` | 3 | BAT-771 |
| `nyne` | 2 | BAT-772 |
| `perplexity` | 1 | (unscheduled) |

