import { once } from "node:events";
import { Agent, createServer, request, type Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createShutdown, ShutdownTimeoutError } from "../src/index";

async function listen(server: Server): Promise<string> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;
	return `http://127.0.0.1:${port}`;
}

function fetchText(url: string, agent: Agent): Promise<string> {
	return new Promise((resolve, reject) => {
		const req = request(url, { agent }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				body += chunk;
			});
			res.on("end", () => resolve(body));
			res.on("error", reject);
		});
		req.on("error", reject);
		req.end();
	});
}

describe("attachHttpServer", () => {
	it("does not hang on an idle keep-alive client", async () => {
		const server = createServer((_req, res) => {
			res.end("ok");
		});
		const url = await listen(server);
		const agent = new Agent({ keepAlive: true });
		expect(await fetchText(url, agent)).toBe("ok");

		const exit = vi.fn();
		const shutdown = createShutdown({ timeoutMs: 200, exit });
		shutdown.attachHttpServer(server);

		const report = await shutdown.run();

		expect(report.forced).toBe(false);
		expect(report.steps[0]?.status).toBe("ok");
		expect(report.steps[0]?.durationMs).toBeLessThan(150);
		expect(server.listening).toBe(false);
		agent.destroy();
	});

	it("destroys idle keep-alive sockets", async () => {
		const server = createServer((_req, res) => {
			res.end("ok");
		});
		const url = await listen(server);
		const { port } = new URL(url);

		const socket = connect(Number(port), "127.0.0.1");
		await once(socket, "connect");
		socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
		await new Promise<void>((resolve) => {
			socket.on("data", (chunk: Buffer) => {
				if (chunk.toString().includes("ok")) {
					resolve();
				}
			});
		});
		const closed = once(socket, "close");

		const shutdown = createShutdown({ timeoutMs: 2_000, exit: vi.fn() });
		shutdown.attachHttpServer(server);
		const report = await shutdown.run();

		await closed;
		expect(socket.destroyed).toBe(true);
		expect(report.steps[0]?.status).toBe("ok");
	});

	it("serves an in-flight request to completion before closing", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const server = createServer(async (_req, res) => {
			await gate;
			res.end("done");
		});
		const shutdown = createShutdown({ timeoutMs: 2_000, exit: vi.fn() });
		shutdown.attachHttpServer(server);
		const url = await listen(server);

		const agent = new Agent({ keepAlive: true });
		const requestSeen = once(server, "request");
		const pending = fetchText(url, agent);
		await requestSeen;
		const run = shutdown.run();
		setTimeout(release, 100);

		const [body, report] = await Promise.all([pending, run]);

		expect(body).toBe("done");
		expect(report.forced).toBe(false);
		expect(report.steps[0]?.status).toBe("ok");
		expect(report.steps[0]?.durationMs).toBeGreaterThanOrEqual(80);
		agent.destroy();
	});

	it("destroys stuck requests after the drain window and reports a timeout", async () => {
		const server = createServer(() => {
			// Never responds.
		});
		const shutdown = createShutdown({ timeoutMs: 100, exit: vi.fn() });
		shutdown.attachHttpServer(server);
		const url = await listen(server);

		const agent = new Agent({ keepAlive: true });
		const requestSeen = once(server, "request");
		const pending = fetchText(url, agent).then(
			() => "resolved",
			(error: Error) => error.message,
		);
		await requestSeen;

		const report = await shutdown.run();

		expect(report.steps[0]?.status).toBe("timeout");
		expect(report.steps[0]?.error).toBeInstanceOf(ShutdownTimeoutError);
		expect(await pending).toMatch(/socket hang up|aborted|ECONNRESET/i);
		expect(server.listening).toBe(false);
		agent.destroy();
	});

	it("treats a server that never listened as already closed", async () => {
		const server = createServer();
		const shutdown = createShutdown({ exit: vi.fn() });
		shutdown.attachHttpServer(server);

		const report = await shutdown.run();

		expect(report.steps[0]?.status).toBe("ok");
	});

	it("uses the step name and rejects a duplicate attachment name", () => {
		const shutdown = createShutdown({ exit: vi.fn() });
		shutdown.attachHttpServer(createServer(), { name: "public" });
		expect(() => shutdown.attachHttpServer(createServer(), { name: "public" })).toThrow(
			/duplicate step name "public"/,
		);
	});
});
