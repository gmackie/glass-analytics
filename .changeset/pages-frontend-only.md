---
"dataflare-cli": minor
---

client-init supports Cloudflare Pages and other static sites as frontend-only apps: it installs the journey loader and registers the project with its allowed origins, and skips the Worker/Durable Object helpers, service binding and proxy. Detected from `pages_build_output_dir` or a static site with no Worker `main`, or forced with `--frontend-only`.
