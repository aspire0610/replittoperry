---
name: Perplexity Agent API
description: Current Perplexity structured-output API contract and migration away from legacy Sonar Chat Completions.
---

For new Perplexity integrations, verify the current official API contract instead of assuming the familiar Chat Completions endpoint. Current documentation centers on `POST /v1/agent`; structured output uses `response_format` with a JSON schema, and generated text is returned in Agent API output message content rather than a `choices` array. Set `store: false` when request prompts should not be retained.

**Why:** The legacy Sonar Chat Completions reference leads to migration guidance, and the current API has a different request and response shape. Reusing an OpenAI Chat Completions parser can silently miss successful Perplexity output.

**How to apply:** Before implementing or upgrading a Perplexity provider, check the official docs for its endpoint, model ID, JSON schema format, and output envelope. Extract only text output, then leave application parsing and domain validation in control.