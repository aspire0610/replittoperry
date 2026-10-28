---
name: Streamlit first-run prompt
description: Avoid workflow startup timeouts caused by Streamlit's optional first-run email prompt.
---

When Streamlit's first-run welcome prompt is attached to a non-interactive workflow, it can wait for an optional email response and never open the configured web port.

**Why:** The workflow timed out even though dependencies and the app were correct; logs showed Streamlit waiting at `Email:`.

**How to apply:** If startup logs stop at the welcome email prompt, pipe one blank line into the Streamlit command (for example, `printf '\n' | streamlit run app.py --server.port 5000 --server.address 0.0.0.0`) before diagnosing app code or port routing.