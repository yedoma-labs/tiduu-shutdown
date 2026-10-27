# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.x     | :white_check_mark: |

The package is pre-1.0. Only the latest published version receives fixes.

## Security Model

`@yedoma-labs/tiduu-shutdown` runs teardown callbacks that your code registers, in response to signals or to an explicit `run()` call. The security model assumes:

- **Registered callbacks and options** are written by trusted developers, not taken from user input
- **Signal names** passed to `signals` are developer-controlled
- **HTTP requests** are untrusted, but the library only observes their lifecycle (socket and response events). It does not parse or act on request content

## Security Features

1. **Bounded shutdown**
   - A per-step timeout and a global deadline ensure the process cannot wait forever on a teardown step
   - Forced sockets are destroyed after the HTTP drain window
2. **Exit guarantees**
   - Signal-triggered shutdowns always call `exit` exactly once, even when a step hangs
   - A second signal during shutdown forces an immediate exit
3. **No runtime dependencies**
   - Nothing beyond Node.js built-ins runs in production

## Known Limitations

1. **Steps cannot be cancelled**
   - A step that exceeds its timeout keeps running in the background. The library stops waiting for it, but JavaScript offers no way to abort it.
   - **Mitigation:** Keep teardown callbacks bounded, and make them idempotent.
2. **Process-level signal handling**
   - `installSignalHandlers` attaches listeners to `process`. Other code that listens for the same signals keeps receiving them.
3. **Partially received requests**
   - A socket that is idle from the library's point of view is destroyed when draining starts. A client that is still sending headers loses that request.

## Reporting Vulnerabilities

If you discover a security vulnerability in `@yedoma-labs/tiduu-shutdown`, please open a GitHub issue.

Please include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We aim to respond within 48 hours and will coordinate disclosure.

## License

MIT - See [LICENSE](LICENSE) for details.
