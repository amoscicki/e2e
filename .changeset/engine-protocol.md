---
"e2e": patch
---

Add the engine protocol: `connectEngine`, `serveEngine`, and transports in `e2e/engine` run an engine in another process, on another machine, or in another language over LSP-style JSON-RPC. `E2E_ENGINE_LOOPBACK=1` runs every engine through the protocol in process.
