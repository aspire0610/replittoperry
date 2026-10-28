---
name: Market checklist evidence
description: Evidence and data-date rules for the Taiwan market direction checklist.
---

**Rule:** Show only signals obtained from queried sources. During Taiwan market hours, use fresh intraday index, representative-stock, and futures quotes for directional checks, and refresh them frequently. Market events must be looked up directly and shown with source links; do not rely on AI-summary state or model memory. Preserve each source timestamp; official breadth, turnover, and institutional flows must not be inferred from representative stocks. Apply staleness per item: stale daily data must not suppress separately verified current quotes, and must not produce current directions after hours.

**Why:** The user asked for dynamically updated intraday signals and direct lookup of recent market events; stale daily values are not acceptable substitutes, while breadth and institutional flows still require official data.

**How to apply:** Keep the source and its own observed date beside every checklist item. Mark unavailable any live quote that is missing or stale. Filter directly searched events for clear topic and date evidence, retain clickable source links, and mark search leads as unverified; otherwise show that no event was verified. Retain only independently fresh items and withhold the overall conclusion when too few current signals remain.
