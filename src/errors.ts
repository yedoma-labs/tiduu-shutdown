/** Raised when a step, the HTTP drain, or the global deadline runs out of time. */
export class ShutdownTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ShutdownTimeoutError";
	}
}

export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}
