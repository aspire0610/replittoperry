---
name: Recharts errorbar rendering
description: Avoid zero-length error bars when charting a reference point alongside projected ranges.
---

Do not attach a zero-length ErrorBar to the current-price reference point. Recharts can create coincident endpoint lines with repeated React keys; keep the reference point outside the ErrorBar data or leave its error value unset.

**Why:** Rendering the same reference price as both error bounds triggered duplicate child-key warnings when the forecast chart appeared.

**How to apply:** Attach ErrorBar only to estimates with a valid low/high range. Render the reference price separately, while keeping any connecting forecast line in its own series if needed.