---
name: Replit mobile preview width
description: Distinguish app CSS sizing from the in-app preview frame when a phone screenshot shows a blank side region.
---

When a phone screenshot captured in Replit App shows the web page using only part of the screen, compare it with a standard browser preview at the same CSS width before widening app containers.

**Why:** the 402px browser preview rendered full width while the screenshot from Replit App showed a narrower web area; that difference alone does not prove whether the cause is the app or its host frame.

**How to apply:** verify in a direct mobile browser or measure the app's actual viewport before changing layout widths; never try to make app CSS escape its embedded viewport.
