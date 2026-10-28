---
name: Admin account deletion
description: User-management removal semantics for the stock dashboard.
---

When an administrator removes a user from the dashboard user-management page, the intended action is permanent Clerk account deletion, not reversible access revocation.

**Why:** The user explicitly chose permanent Clerk deletion for the requested “remove user” feature.

**How to apply:** Require an explicit confirmation before deletion, protect the current/bootstrap/other administrator accounts, and state which separately stored app data is or is not removed.
