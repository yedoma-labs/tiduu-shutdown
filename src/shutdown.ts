import { ShutdownTimeoutError, toError } from "./errors";
import { closeHttpServer, HTTP_DESTROY_GRACE_MS, HttpConnectionTracker } from "./http";
import type {
	AttachHttpServerOptions,
	HttpServerLike,
	RegisterOptions,
	Shutdown,
	ShutdownOptions,
	ShutdownReport,
	StepReport,
} from "./types";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_SIGNALS: readonly string[] = ["SIGTERM", "SIGINT"];
const INTERRUPTED = Symbol("interrupted");

interface Step {
	readonly name: string;
	readonly close: () => unknown;
	readonly timeoutMs: number;
}

export function createShutdown(options: ShutdownOptions = {}): Shutdown {
	const timeoutMs = assertTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
	const signals = options.signals ?? DEFAULT_SIGNALS;
	const exit = options.exit ?? defaultExit;
	const log = options.log ?? noop;

	const steps: Step[] = [];
	const names = new Set<string>();
	let runPromise: Promise<ShutdownReport> | undefined;
	let finished = false;
	let exitCalled = false;
	// Set while the run loop is active. Stops the loop early with the given cause.
	let interruptRun: ((cause: string) => void) | undefined;

	function register(name: string, close: () => unknown, registerOptions: RegisterOptions = {}) {
		if (runPromise !== undefined) {
			throw new Error(`tiduu-shutdown: cannot register "${name}" after shutdown has started`);
		}
		if (names.has(name)) {
			throw new Error(`tiduu-shutdown: duplicate step name "${name}"`);
		}
		names.add(name);
		steps.push({
			name,
			close,
			timeoutMs: assertTimeout(
				registerOptions.timeoutMs ?? timeoutMs,
				`timeoutMs for step "${name}"`,
			),
		});
	}

	function attachHttpServer(server: HttpServerLike, attachOptions: AttachHttpServerOptions = {}) {
		const name = attachOptions.name ?? "http-server";
		const drainMs = assertTimeout(attachOptions.timeoutMs ?? timeoutMs, `timeoutMs for "${name}"`);
		const tracker = new HttpConnectionTracker(server);
		register(name, () => closeHttpServer(server, tracker, drainMs), {
			timeoutMs: drainMs + HTTP_DESTROY_GRACE_MS,
		});
	}

	function run(reason?: string): Promise<ShutdownReport> {
		if (runPromise === undefined) {
			runPromise = execute(reason);
		}
		return runPromise;
	}

	async function execute(reason: string | undefined): Promise<ShutdownReport> {
		log(`shutdown started${reason ? ` (${reason})` : ""}`);

		const ordered = [...steps].reverse();
		const reports: StepReport[] = [];
		let forced = false;
		let interruptCause: string | undefined;

		let resolveInterrupt: () => void = noop;
		const interrupted = new Promise<typeof INTERRUPTED>((resolve) => {
			resolveInterrupt = () => resolve(INTERRUPTED);
		});
		interruptRun = (cause) => {
			interruptCause ??= cause;
			resolveInterrupt();
		};
		const deadline = setTimeout(
			() => interruptRun?.(`global deadline of ${timeoutMs}ms exceeded`),
			timeoutMs,
		);

		try {
			for (const [index, step] of ordered.entries()) {
				const startedAt = performance.now();
				log(`shutdown: closing "${step.name}"`);

				const outcome = await Promise.race([runStep(step), interrupted]);
				if (outcome === INTERRUPTED) {
					forced = true;
					const cause = interruptCause ?? "shutdown interrupted";
					reports.push({
						name: step.name,
						status: "timeout",
						durationMs: elapsedSince(startedAt),
						error: new ShutdownTimeoutError(cause),
					});
					for (const pending of ordered.slice(index + 1)) {
						reports.push({ name: pending.name, status: "timeout", durationMs: 0 });
					}
					log(`shutdown: ${cause}, ${ordered.length - index} step(s) marked as timeout`);
					break;
				}

				reports.push(outcome);
				log(`shutdown: "${step.name}" ${outcome.status} (${Math.round(outcome.durationMs)}ms)`);
			}
		} finally {
			clearTimeout(deadline);
			interruptRun = undefined;
			finished = true;
		}

		return { steps: reports, forced };
	}

	function installSignalHandlers(): () => void {
		const listeners = signals.map((signal) => {
			const listener = () => onSignal(signal);
			process.on(signal, listener);
			return { signal, listener };
		});

		let removed = false;
		return () => {
			if (removed) {
				return;
			}
			removed = true;
			for (const { signal, listener } of listeners) {
				process.off(signal, listener);
			}
		};
	}

	function onSignal(signal: string): void {
		if (finished) {
			return;
		}
		if (runPromise === undefined) {
			// First signal: start the teardown and exit once it has completed.
			void run(signal).then((report) => {
				const clean = !report.forced && report.steps.every((step) => step.status === "ok");
				exitOnce(clean ? 0 : 1);
			});
			return;
		}
		// Second signal while shutting down: stop waiting and exit immediately.
		interruptRun?.(`forced by a second ${signal}`);
		void runPromise.then(() => exitOnce(1));
	}

	function exitOnce(code: number): void {
		if (exitCalled) {
			return;
		}
		exitCalled = true;
		exit(code);
	}

	return { register, attachHttpServer, run, installSignalHandlers };
}

async function runStep(step: Step): Promise<StepReport> {
	const startedAt = performance.now();
	try {
		await withTimeout(step.name, step.timeoutMs, () => step.close());
		return { name: step.name, status: "ok", durationMs: elapsedSince(startedAt) };
	} catch (cause) {
		const error = toError(cause);
		return {
			name: step.name,
			status: error instanceof ShutdownTimeoutError ? "timeout" : "error",
			durationMs: elapsedSince(startedAt),
			error,
		};
	}
}

function withTimeout(name: string, timeoutMs: number, task: () => unknown): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new ShutdownTimeoutError(`step "${name}" exceeded ${timeoutMs}ms`));
		}, timeoutMs);
		Promise.resolve()
			.then(task)
			.then(
				() => resolve(),
				(cause: unknown) => reject(cause),
			)
			.finally(() => clearTimeout(timer));
	});
}

function assertTimeout(value: number, label: string): number {
	if (!Number.isFinite(value) || value <= 0) {
		throw new RangeError(
			`tiduu-shutdown: ${label} must be a positive finite number of milliseconds, got ${value}`,
		);
	}
	return value;
}

function elapsedSince(startedAt: number): number {
	return performance.now() - startedAt;
}

function defaultExit(code: number): void {
	process.exit(code);
}

function noop(): void {}
