# paysh-catalog maintenance status

Generated: 2026-05-16T15:29:36.582Z
Catalog generated_at: 2026-05-16T15:28:12.296Z
Manifest last checked: 2026-05-16T15:28:12.296Z (run `probe-catalog.js --drift` to refresh)
Freshness window: 30 days

## Summary

| Bucket | Count |
|--------|-------|
| Catalog entries | 10 |
| Unsupported entries | 62 |
| Fresh (capture ≤ 30d) | 51 |
| Stale (capture > 30d) | 0 |
| No capture (probe never reached 402) | 21 |
| Entries with audit_pending siblings | 9 |
| Total audit_pending sibling endpoints | 208 |

## Audit-pending siblings (queued for catalog promotion)

| service_id | pending count | deferred_to |
|---|---|---|
| `rpc` | 133 | (unscheduled) |
| `stablesocial-social-data` | 36 | (unscheduled) |
| `stableemail-email` | 11 | BAT-770 |
| `fal` | 9 | BAT-764 |
| `email` | 8 | (unscheduled) |
| `screenshotone` | 3 | BAT-764 |
| `perplexity` | 3 | BAT-769 |
| `stablephone-calls` | 3 | BAT-771 |
| `nyne` | 2 | BAT-772 |

