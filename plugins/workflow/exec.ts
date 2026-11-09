/**
 * Process execution for the `world.run` facade.
 *
 * One call runs once and its result is recorded, so a resumed or amended run
 * can reuse it. A completed process resolves, nonzero exit included; only a
 * spawn failure or a timeout rejects.
 */

import { spawn } from "node:child_process"

export interface ProcessResult {
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
}

export type OutputOption = "full" | "discard" | { readonly tail: number }

export interface ProcessOptions {
	readonly cwd: string
	readonly timeoutMs?: number
	readonly output?: OutputOption
	readonly signal?: AbortSignal
}

export const FULL_OUTPUT_CAP = 16 * 1024 * 1024
export const DEFAULT_TIMEOUT_MS = 300_000

export class ProcessError extends Error {
	readonly kind: "spawn" | "timeout" | "aborted" | "cap"

	constructor(message: string, kind: ProcessError["kind"]) {
		super(message)
		this.name = "ProcessError"
		this.kind = kind
	}
}

interface Collector {
	push(chunk: Buffer): void
	text(): string
	overflowed(): boolean
}

/**
 * Retains at most `cap` bytes, dropping the oldest chunks once the buffer
 * grows past it. `overflowed()` remembers that anything was dropped.
 */
function collector(cap: number): Collector {
	const chunks: Buffer[] = []
	let size = 0
	let overflow = false
	return {
		push(chunk) {
			chunks.push(chunk)
			size += chunk.length
			while (size > cap && chunks.length > 1) {
				const dropped = chunks.shift()
				if (!dropped) break
				size -= dropped.length
				overflow = true
			}
		},
		text() {
			return Buffer.concat(chunks).toString("utf8")
		},
		overflowed() {
			return overflow
		},
	}
}

function tailBytes(text: string, limit: number): string {
	const buffer = Buffer.from(text, "utf8")
	if (buffer.length <= limit) return text
	return buffer.subarray(buffer.length - limit).toString("utf8")
}

export function runProcess(command: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
	if (options.signal?.aborted) return Promise.reject(new ProcessError("The run was stopped.", "aborted"))
	if (!command.trim()) return Promise.reject(new ProcessError("world.run was given an empty command.", "spawn"))

	return new Promise<ProcessResult>((resolve, reject) => {
		let child: ReturnType<typeof spawn>
		try {
			child = spawn(command, [...args], { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], shell: false })
		} catch (error) {
			reject(new ProcessError(`Could not start "${command}": ${error instanceof Error ? error.message : String(error)}`, "spawn"))
			return
		}

		const mode = options.output ?? "full"
		const cap = mode === "discard" ? 1 : FULL_OUTPUT_CAP
		const stdout = collector(cap)
		const stderr = collector(cap)
		let settled = false
		let timedOut = false

		const cleanup = () => {
			clearTimeout(timer)
			options.signal?.removeEventListener("abort", onAbort)
		}

		const fail = (error: ProcessError) => {
			if (settled) return
			settled = true
			cleanup()
			reject(error)
		}

		const timer = setTimeout(() => {
			timedOut = true
			child.kill("SIGKILL")
		}, timeoutMs)

		const onAbort = () => child.kill("SIGKILL")
		options.signal?.addEventListener("abort", onAbort, { once: true })

		child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk))
		child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk))

		child.on("error", (error) => {
			fail(new ProcessError(`Could not run "${command}": ${error.message}`, "spawn"))
		})

		child.on("close", (code) => {
			if (settled) return
			if (timedOut) {
				fail(new ProcessError(`"${command}" timed out after ${timeoutMs} ms.`, "timeout"))
				return
			}
			if (options.signal?.aborted) {
				fail(new ProcessError("The run was stopped.", "aborted"))
				return
			}
			const stdoutText = stdout.text()
			const stderrText = stderr.text()
			if (mode === "full" && (stdout.overflowed() || stderr.overflowed())) {
				fail(
					new ProcessError(
						`"${command}" printed more than the 16 MiB cap. Pass { output: "discard" } or { output: { tail: n } }.`,
						"cap",
					),
				)
				return
			}
			settled = true
			cleanup()
			resolve({
				exitCode: code ?? 0,
				stdout: mode === "discard" ? "" : typeof mode === "object" ? tailBytes(stdoutText, mode.tail) : stdoutText,
				stderr: mode === "discard" ? "" : typeof mode === "object" ? tailBytes(stderrText, mode.tail) : stderrText,
			})
		})
	})
}
