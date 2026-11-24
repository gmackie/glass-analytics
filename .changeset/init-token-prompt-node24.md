---
"dataflare-cli": patch
---

`dataflare init` no longer fails in a terminal on Node 24 with "Cannot read properties of undefined (reading 'bind')". The API-token prompt hides what you type with a muted output stream instead of patching readline internals.
