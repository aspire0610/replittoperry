---
name: Dashboard card layout scope
description: User requirements for future visual and card-order changes in the Taiwan stock dashboard.
---

Only the homepage has card-order controls. Use compact up/down buttons instead of pointer dragging; keep buttons within the existing nested card groups, and do not add sorting to other pages. When changing the layout interaction, restore the original default card order while preserving each card's collapsed state. Do not change market data, investment research logic, or APIs as part of visual/layout work.

**Why:** The user found drag sorting poor on narrow phone screens and asked to return to button-based sorting, restore the prior order, and refine the buttons.

**How to apply:** Limit move-up/move-down controls to homepage cards and their existing groups; when resetting saved order, retain collapsed state and leave other page layouts static.
