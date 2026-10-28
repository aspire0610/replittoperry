---
name: LINE account binding
description: Account isolation expectations for LINE notification links.
---

Different dashboard accounts should be able to link different LINE user identities. Keep each account's LINE settings scoped to its own Clerk user and avoid a global single-link restriction.

**Why:** The user confirmed that the second dashboard account is intended to connect a different LINE account.

**How to apply:** When diagnosing link failures, distinguish settings/API access errors from LINE identity collisions; do not loosen the invite-only account access policy to make linking work.
