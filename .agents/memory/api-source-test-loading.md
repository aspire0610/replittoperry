---
name: API source test loading
description: Test-runner behavior for API server TypeScript source files with ESM .js import specifiers.
---

API server source files use `.js` specifiers for local TypeScript imports. Native `node --test` can run isolated TypeScript modules without those imports, but fails to resolve local `.js` specifiers back to `.ts`. The workspace does not provide `tsx` as a root executable.

**Why:** a direct test run on Node v24 failed with `ERR_MODULE_NOT_FOUND` for `.js` import specifiers, while attempting `pnpm exec tsx` failed because no such executable is installed.

**How to apply:** use the API build output or the project's supported TypeScript-aware test loader for tests that import modules with local `.js` specifiers. Keep lightweight source tests for pure modules that do not import those files.
