export type StepStatus = "ok" | "error" | "timeout";

export interface StepReport {
	/** Name the step was registered under. */
	readonly name: string;
	readonly status: StepStatus;
	readonly durationMs: number;
	/** Set for `error` steps, and for `timeout` steps when a cause is known. */
	readonly error?: Error;
}

export interface ShutdownReport {
	/** Steps in teardown order (reverse registration order). */
	readonly steps: readonly StepReport[];
	/** True when the global deadline or a second signal cut the shutdown short. */
	readonly forced: boolean;
}

export interface RegisterOptions {
	/** Per-step timeout in milliseconds. Defaults to the global `timeoutMs`. */
	readonly timeoutMs?: number;
}

export interface AttachHttpServerOptions {
	/** Step name. Defaults to `"http-server"`. */
	readonly name?: string;
	/**
	 * Drain window in milliseconds. After it elapses, all remaining sockets are destroyed.
	 * Defaults to the global `timeoutMs`.
	 */
	readonly timeoutMs?: number;
}

export interface ShutdownOptions {
	/** Global deadline for the whole shutdown in milliseconds. Defaults to 10000. */
	readonly timeoutMs?: number;
	/** Signals that trigger the shutdown. Defaults to `["SIGTERM", "SIGINT"]`. */
	readonly signals?: readonly string[];
	/** Called with the final exit code. Defaults to `process.exit`. */
	readonly exit?: (code: number) => void;
	/** Optional progress logger. Silent by default. */
	readonly log?: (message: string) => void;
}

/**
 * Structural subset of `http.Server`. Any `node:http` server satisfies it,
 * so this package does not need `@types/node` in its public types.
 */
export interface HttpServerLike {
	close(callback?: (error?: Error) => void): unknown;
	on<Args extends unknown[]>(event: string, listener: (...args: Args) => void): unknown;
}

export interface Shutdown {
	/**
	 * Registers a teardown step. Steps are registered in startup order and torn down
	 * in reverse order. Throws on duplicate names or after shutdown has started.
	 */
	register(name: string, close: () => unknown, options?: RegisterOptions): void;
	/** Registers an HTTP server: stops accepting, drains requests, then destroys sockets. */
	attachHttpServer(server: HttpServerLike, options?: AttachHttpServerOptions): void;
	/** Runs the teardown. Idempotent: repeated calls return the same promise. */
	run(reason?: string): Promise<ShutdownReport>;
	/** Listens for the configured signals. Returns a function that removes the listeners. */
	installSignalHandlers(): () => void;
}
