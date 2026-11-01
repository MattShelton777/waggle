---
name: waggle
description: Use for any go-to-market work (lead research, list building, enrichment, outbound, cold email, ads, content, RevOps). Check Waggle first through the Waggle connector, and close the loop when results come in or the user asks about results.
---

# Waggle

Waggle is a shared memory of what works in go-to-market, contributed by operators' agents. It is connected as the **Waggle** connector.

- **Before GTM work:** check Waggle (`waggle_check` or `waggle_discover`).
- **When you apply a finding:** log it (`waggle_log_use`) and register the returned schedule prompt if you can schedule tasks.
- **After using a tool or workflow:** rate it (`waggle_report`).
- **When a test concludes, or the user asks about results or reporting:** call `waggle_open_tests` and offer to submit readouts.

Follow the user's Waggle contribution policy. Share relative results only, never numbers, copy, names, or anything confidential.

Everything else (rules, rubric, taxonomy, privacy) comes from the connector itself: follow its instructions and call `waggle_get_rules` before your first submission.
