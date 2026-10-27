import { ShutdownTimeoutError } from "./errors";
import type { HttpServerLike } from "./types";

/** Extra time the HTTP step gets beyond its drain window, so forced socket destruction can finish. */
export const HTTP_DESTROY_GRACE_MS = 1_000;

interface SocketLike {
	destroy(): unknown;
	once(event: "close", listener: () => void): unknown;
}

interface RequestLike {
	readonly socket: SocketLike;
}

interface ResponseLike {
	once(event: "finish" | "close", listener: () => void): unknown;
}

interface Connection {
	/** Number of requests on this socket that have not finished yet. */
	active: number;
}

/**
 * Tracks the sockets of an HTTP server so that keep-alive connections without an
 * in-flight request can be closed as soon as draining starts.
 */
export class HttpConnectionTracker {
	private readonly connections = new Map<SocketLike, Connection>();
	private draining = false;

	constructor(server: HttpServerLike) {
		server.on("connection", (socket: SocketLike) => {
			const connection = this.track(socket);
			if (this.draining && connection.active === 0) {
				socket.destroy();
			}
		});
		server.on("request", (req: RequestLike, res: ResponseLike) => {
			this.onRequest(req.socket, res);
		});
	}

	/** Marks the server as draining and closes every socket that is currently idle. */
	startDrain(): void {
		this.draining = true;
		for (const [socket, connection] of this.connections) {
			if (connection.active === 0) {
				socket.destroy();
			}
		}
	}

	/** Destroys every tracked socket, including ones with in-flight requests. */
	destroyAll(): void {
		for (const socket of this.connections.keys()) {
			socket.destroy();
		}
	}

	private track(socket: SocketLike): Connection {
		const existing = this.connections.get(socket);
		if (existing) {
			return existing;
		}
		const connection: Connection = { active: 0 };
		this.connections.set(socket, connection);
		socket.once("close", () => {
			this.connections.delete(socket);
		});
		return connection;
	}

	private onRequest(socket: SocketLike, res: ResponseLike): void {
		const connection = this.track(socket);
		connection.active += 1;

		let released = false;
		const release = () => {
			if (released) {
				return;
			}
			released = true;
			connection.active -= 1;
			// A keep-alive socket that finished its last response would otherwise stay open.
			if (this.draining && connection.active === 0) {
				socket.destroy();
			}
		};
		res.once("finish", release);
		res.once("close", release);
	}
}

/**
 * Stops the server from accepting connections and waits for in-flight requests.
 * If they do not finish within `drainMs`, all sockets are destroyed and a
 * `ShutdownTimeoutError` is thrown.
 */
export async function closeHttpServer(
	server: HttpServerLike,
	tracker: HttpConnectionTracker,
	drainMs: number,
): Promise<void> {
	const closed = new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error && !isNotRunningError(error)) {
				reject(error);
			} else {
				resolve();
			}
		});
	});

	tracker.startDrain();

	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(true), drainMs);
	});

	let timedOut: boolean;
	try {
		timedOut = await Promise.race([closed.then(() => false), expired]);
	} finally {
		clearTimeout(timer);
	}

	if (!timedOut) {
		return;
	}

	tracker.destroyAll();
	await closed;
	throw new ShutdownTimeoutError(
		`HTTP server still had active requests after ${drainMs}ms; sockets were destroyed`,
	);
}

function isNotRunningError(error: Error): boolean {
	return (error as { code?: unknown }).code === "ERR_SERVER_NOT_RUNNING";
}
