import { describe, expect, it, vi } from "vitest";
import { createShutdown, type ShutdownOptions, ShutdownTimeoutError } from "../src/index";

/** Every test passes a mocked `exit`, so no test can terminate the runner process. */
function create(options: ShutdownOptions = {}) {
	const exit = vi.fn<(code: number) => void>();
	const shutdown = createShutdown({ exit, ...options });
	return { shutdown, exit };
}

const hang = () => new Promise<void>(() => {});
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("teardown order", () => {
	it("tears steps down in reverse registration order", async () => {
		const { shutdown } = create();
		const calls: string[] = [];
		shutdown.register("db", () => {
			calls.push("db");
		});
		shutdown.register("cache", () => {
			calls.push("cache");
		});
		shutdown.register("server", () => {
			calls.push("server");
		});

		const report = await shutdown.run();

		expect(calls).toEqual(["server", "cache", "db"]);
		expect(report.steps.map((step) => step.name)).toEqual(["server", "cache", "db"]);
		expect(report.steps.every((step) => step.status === "ok")).toBe(true);
		expect(report.forced).toBe(false);
	});

	it("runs steps sequentially, waiting for each to finish", async () => {
		const { shutdown } = create();
		const events: string[] = [];
		shutdown.register("db", () => {
			events.push("db");
		});
		shutdown.register("server", async () => {
			events.push("server:start");
			await sleep(20);
			events.push("server:end");
		});

		await shutdown.run();

		expect(events).toEqual(["server:start", "server:end", "db"]);
	});

	it("reports an empty shutdown as successful", async () => {
		const { shutdown } = create();
		expect(await shutdown.run()).toEqual({ steps: [], forced: false });
	});
});

describe("error handling", () => {
	it("collects errors from sync and async steps without aborting", async () => {
		const { shutdown } = create();
		const syncError = new Error("sync boom");
		const asyncError = new Error("async boom");
		const laterClose = vi.fn();
		shutdown.register("db", laterClose);
		shutdown.register("sync", () => {
			throw syncError;
		});
		shutdown.register("async", async () => {
			throw asyncError;
		});

		const report = await shutdown.run();

		expect(report.steps.map((step) => step.status)).toEqual(["error", "error", "ok"]);
		expect(report.steps[0]?.error).toBe(asyncError);
		expect(report.steps[1]?.error).toBe(syncError);
		expect(laterClose).toHaveBeenCalledOnce();
		expect(report.forced).toBe(false);
	});

	it("wraps non-Error rejections in an Error", async () => {
		const { shutdown } = create();
		shutdown.register("odd", () => Promise.reject("plain string"));

		const [step] = (await shutdown.run()).steps;
		expect(step?.status).toBe("error");
		expect(step?.error).toBeInstanceOf(Error);
		expect(step?.error?.message).toBe("plain string");
	});
});

describe("timeouts", () => {
	it("marks a step that exceeds its own timeout and continues", async () => {
		const { shutdown } = create({ timeoutMs: 5_000 });
		const fastClose = vi.fn();
		shutdown.register("hangs", hang, { timeoutMs: 20 });
		shutdown.register("fast", fastClose);

		const report = await shutdown.run();

		expect(fastClose).toHaveBeenCalledOnce();
		expect(report.steps.map((step) => [step.name, step.status])).toEqual([
			["fast", "ok"],
			["hangs", "timeout"],
		]);
		expect(report.steps[1]?.error).toBeInstanceOf(ShutdownTimeoutError);
		expect(report.forced).toBe(false);
	});

	it("marks remaining steps as timeout when the global deadline passes", async () => {
		const { shutdown, exit } = create({ timeoutMs: 50 });
		const dbClose = vi.fn();
		const serverClose = vi.fn();
		shutdown.register("db", dbClose);
		shutdown.register("hang", hang, { timeoutMs: 10_000 });
		shutdown.register("server", serverClose);

		const report = await shutdown.run();

		expect(serverClose).toHaveBeenCalledOnce();
		expect(dbClose).not.toHaveBeenCalled();
		expect(report.forced).toBe(true);
		expect(report.steps.map((step) => [step.name, step.status])).toEqual([
			["server", "ok"],
			["hang", "timeout"],
			["db", "timeout"],
		]);
		expect(report.steps[1]?.durationMs).toBeGreaterThanOrEqual(40);
		// run() alone never exits the process.
		expect(exit).not.toHaveBeenCalled();
	});

	it("rejects invalid timeouts", () => {
		expect(() => createShutdown({ timeoutMs: 0, exit: vi.fn() })).toThrow(RangeError);
		expect(() => createShutdown({ timeoutMs: Number.NaN, exit: vi.fn() })).toThrow(RangeError);
		const { shutdown } = create();
		expect(() => shutdown.register("bad", () => {}, { timeoutMs: -1 })).toThrow(RangeError);
	});
});

describe("run()", () => {
	it("is idempotent and returns the same promise", async () => {
		const { shutdown } = create();
		const close = vi.fn();
		shutdown.register("db", close);

		const first = shutdown.run("manual");
		const second = shutdown.run();

		expect(second).toBe(first);
		await first;
		expect(shutdown.run()).toBe(first);
		expect(close).toHaveBeenCalledOnce();
	});

	it("rejects registration once shutdown has started", async () => {
		const { shutdown } = create();
		await shutdown.run();
		expect(() => shutdown.register("late", () => {})).toThrow(/after shutdown has started/);
	});

	it("rejects duplicate step names", () => {
		const { shutdown } = create();
		shutdown.register("db", () => {});
		expect(() => shutdown.register("db", () => {})).toThrow(/duplicate step name "db"/);
	});
});

describe("signal handling", () => {
	it("starts the teardown on a signal and exits with 0 on success", async () => {
		const { shutdown, exit } = create({ signals: ["SIGUSR2"] });
		const close = vi.fn();
		shutdown.register("db", close);
		const dispose = shutdown.installSignalHandlers();

		try {
			process.emit("SIGUSR2", "SIGUSR2");
			await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
			expect(close).toHaveBeenCalledOnce();
			expect(exit).toHaveBeenCalledOnce();
		} finally {
			dispose();
		}
	});

	it("exits with 1 when a step failed", async () => {
		const { shutdown, exit } = create({ signals: ["SIGUSR2"] });
		shutdown.register("broken", () => {
			throw new Error("boom");
		});
		const dispose = shutdown.installSignalHandlers();

		try {
			process.emit("SIGUSR2", "SIGUSR2");
			await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
			expect(exit).toHaveBeenCalledOnce();
		} finally {
			dispose();
		}
	});

	it("forces an immediate exit with forced: true on a second signal", async () => {
		const { shutdown, exit } = create({ signals: ["SIGUSR2"], timeoutMs: 5_000 });
		shutdown.register("hang", hang, { timeoutMs: 10_000 });
		const dispose = shutdown.installSignalHandlers();

		try {
			process.emit("SIGUSR2", "SIGUSR2");
			process.emit("SIGUSR2", "SIGUSR2");

			const report = await shutdown.run();
			expect(report.forced).toBe(true);
			expect(report.steps).toEqual([expect.objectContaining({ name: "hang", status: "timeout" })]);
			await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
			expect(exit).toHaveBeenCalledOnce();
		} finally {
			dispose();
		}
	});

	it("removes its listeners when the dispose function is called", () => {
		const { shutdown, exit } = create({ signals: ["SIGUSR1"] });
		const close = vi.fn();
		shutdown.register("db", close);
		const before = process.listenerCount("SIGUSR1");

		const dispose = shutdown.installSignalHandlers();
		expect(process.listenerCount("SIGUSR1")).toBe(before + 1);

		dispose();
		dispose();
		expect(process.listenerCount("SIGUSR1")).toBe(before);

		process.emit("SIGUSR1", "SIGUSR1");
		expect(close).not.toHaveBeenCalled();
		expect(exit).not.toHaveBeenCalled();
	});
});
