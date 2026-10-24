---
'e2e': patch
---

The run summary's `Cache` line counts the steps whose recording was not saved (`step.cache.write` of `unconfirmed`, `no-change`, or `not-written`), such as `4 missed · 1 not saved`. Before, a passing step that left no recording showed only as `step.cache.write` in the JSON report.
