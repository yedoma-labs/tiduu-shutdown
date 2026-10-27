# @yedoma-labs/tiduu-shutdown

Framework-agnostic graceful shutdown for Node.js. It tears your resources down in the right order, with a deadline for each step and a deadline for the whole shutdown, and it drains HTTP keep-alive connections properly.

Zero runtime dependencies. Works with `node:http`, Express, Fastify, or anything that exposes an `http.Server`.

## The problem

Graceful shutdown in Node servers breaks in a few predictable ways:

- **No `SIGTERM` handler.** The process dies immediately and in-flight requests are cut off. The load balancer answers them with a 502.
- **`server.close()` waits for keep-alive sockets.** Before Node 19, its callback does not fire until idle sockets are closed by someone else. A shutdown that calls `close()` and waits on it hangs.
- **Wrong order.** If the database pool closes before the HTTP server has drained, requests still in flight fail with query errors.
- **No deadline.** The orchestrator sends `SIGKILL` before your drain finishes, and nothing has been logged.

This library handles only the teardown: ordering, deadlines, socket handling, and exit codes. It does not do health checks.

## Install

```sh
pnpm add @yedoma-labs/tiduu-shutdown
```

## Quickstart

This example uses `node:http`. Express and Fastify work the same way, because both expose an `http.Server`: for Express pass the return value of `app.listen(...)`, and for Fastify pass `app.server` after `await app.listen(...)`.

```ts
import { createServer } from "node:http";
import { createShutdown } from "@yedoma-labs/tiduu-shutdown";
import { createPool } from "./db"; // any pool with an async end()

const db = createPool();

const server = createServer((req, res) => {
	// ... handle requests with db
	res.end("ok");
});

const shutdown = createShutdown({ timeoutMs: 15_000 });

// Register in startup order: the database first, then the server that uses it.
shutdown.register("db", () => db.end());

server.listen(3000);
shutdown.attachHttpServer(server); // registered after "db", so it is torn down first

shutdown.installSignalHandlers(); // SIGTERM and SIGINT start the teardown
```

On `SIGTERM` the teardown runs in reverse order: the HTTP server stops accepting connections and drains in-flight requests, then the database pool closes. The process exits with `0` when every step succeeded, and with `1` otherwise.

Attach the HTTP server right after you start listening, before it accepts connections. Sockets opened earlier are not tracked.

Set your orchestrator's grace period above `timeoutMs`. For example, use `terminationGracePeriodSeconds` in Kubernetes, so the orchestrator does not send `SIGKILL` first.

## API

```ts
import { createShutdown } from "@yedoma-labs/tiduu-shutdown";

const shutdown = createShutdown({
	timeoutMs: 10_000, // global deadline for the whole shutdown (default 10000)
	signals: ["SIGTERM", "SIGINT"], // default
	exit: (code) => process.exit(code), // default; inject a mock in tests
	log: (message) => console.log(message), // optional, silent by default
});

shutdown.register("name", closeFn, { timeoutMs }); // per-step timeout, defaults to timeoutMs
shutdown.attachHttpServer(server, { name: "http", timeoutMs }); // drain window, defaults to timeoutMs
const report = await shutdown.run("manual"); // optional reason, idempotent
const dispose = shutdown.installSignalHandlers(); // returns a function that removes the listeners
```

### Semantics

- **Order.** Steps are registered in startup order and torn down in reverse (LIFO), one at a time.
- **Errors do not abort.** A step that throws or rejects is recorded as `error`, and the remaining steps still run.
- **Step timeout.** A step that exceeds its timeout is recorded as `timeout`, and the teardown continues.
- **Global deadline.** When `timeoutMs` for the whole shutdown elapses, the step that is running and every step still waiting are marked `timeout`. The report has `forced: true`.
- **Second signal.** A signal received during shutdown stops the teardown immediately. The report has `forced: true`, and the process exits with `1`.
- **Idempotent.** `run()` returns the same promise on every call. Calling `register()` after shutdown has started, or registering a duplicate name, throws.
- **Exit codes.** Only signal-triggered shutdowns exit the process. `exit(0)` is used when every step succeeded and nothing was forced, `exit(1)` otherwise. Calling `run()` yourself never exits.

### The report

```ts
interface ShutdownReport {
	steps: { name: string; status: "ok" | "error" | "timeout"; durationMs: number; error?: Error }[];
	forced: boolean;
}
```

`steps` is in teardown order.

### HTTP draining

`attachHttpServer` does the following:

1. Calls `server.close()` so no new connections are accepted.
2. Destroys every keep-alive socket that has no request in flight.
3. Destroys each socket as soon as its last response has finished, so it is not left idle.
4. Waits for in-flight requests until the drain window (`timeoutMs`) elapses. If requests are still running, it destroys all sockets and marks the step `timeout`.

The step itself gets an extra second of grace on top of the drain window, so the forced destruction has time to finish.

## Limitations

- **No health checks or readiness.** Nothing here reports `/healthz` or `/ready`, and nothing marks the instance as unready before shutdown begins.
- **Load balancer delay is not handled.** Some load balancers keep sending traffic for a few seconds after an instance stops accepting connections. Add a `preStop` sleep or flip your readiness check first. This library does not do that.
- **Steps cannot be cancelled.** A timed-out step keeps running in the background. The library only stops waiting for it.
- **Only the HTTP server is tracked.** Other servers and sockets (WebSockets, gRPC, raw TCP) need their own `register` step.

## Comparison

If you need health checks and readiness, use [`@godaddy/terminus`](https://github.com/godaddy/terminus). It is larger and also covers health endpoints and orchestrator integration. This library only does the teardown.

[`close-with-grace`](https://github.com/mcollina/close-with-grace) is a small helper for signal handling with a grace period.

[`http-terminator`](https://github.com/gajus/http-terminator) focuses on draining HTTP connections, and it was last released in 2022.

`@yedoma-labs/tiduu-shutdown` covers the gap between these: a small, framework-agnostic library that handles only ordered teardown with per-step and global deadlines, plus HTTP socket handling.

## Requirements

Node.js 20 or newer.

## License

MIT. See [LICENSE](LICENSE).
