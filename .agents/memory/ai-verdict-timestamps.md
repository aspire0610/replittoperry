---
name: AI buy-price verdict timestamps
description: Preserve visibility and provenance when a price check uses a different AI-analysis snapshot than the dashboard currently displays.
---

When displaying an AI buy-price verdict, match it to the selected stock and entered price, not to an exact equality with the dashboard's current analysis timestamp. Show the verdict's own analysis time, and disclose when it differs from the report on screen.

**Why:** The price-check endpoint may use a different in-memory assessment snapshot than the separate assessment request. Hiding the verdict on timestamp mismatch made a valid check appear to have failed.

**How to apply:** Treat the server-returned verdict and its quote/analysis timestamps as the source for that check. Keep the result bound to the submitted stock and price; do not suppress it solely because another request returned a different assessment timestamp.
