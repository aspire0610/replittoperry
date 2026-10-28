---
name: Vercel function duration
description: Current platform timeout limits to check when diagnosing long-running API requests.
---

As of 2026-10-04, Vercel's official Functions duration page reports Fluid Compute enabled by default, with Hobby default and maximum function duration both at 300 seconds. Older Vercel changelog results mention a 60-second Hobby limit and may be stale.

**Why:** The Taiwan dashboard's production project is on Hobby, and relying on older duration information could lead to unnecessary timeout changes or incorrect root-cause claims.

**How to apply:** Before changing provider order or function duration, verify the current plan and Fluid Compute settings in official docs. Keep browser/request deadlines below the current platform deadline, and distinguish an app timeout from Vercel's function limit.