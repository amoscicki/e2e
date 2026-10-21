---
"e2e": patch
---

`e2e mcp` sessions have a `try_lines` tool. Pass it test statements as a test body writes them, such as `await screen.getByLabel('Email').fill('ada@example.com')`, and the session runs them on its own fixtures with a test's waits, exactly-one rule, and matchers. It stops at the first failure and returns each statement's result, then what changed on screen. Each statement waits at most 5 seconds unless `timeout` says otherwise. The server parses the code into a closed grammar and never runs it as JavaScript, and a secret `fill` passes the same checks as `type_secret`. The bundled skill tells the coding agent to try a step's lines in the session before it writes them into the test.
