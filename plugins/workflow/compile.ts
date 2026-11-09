/**
 * Script compilation and static preflight.
 *
 * A workflow script is a JavaScript (or TypeScript, when the host provides
 * Bun's transpiler) function body. The engine wraps it in an async function and
 * calls it with the facade. This module owns everything that can be decided
 * before the script runs: syntax, the phase names the graph needs, the command
 * set the user approves, and a few constructs that cannot work in a script.
 */

export interface Diagnostic {
	readonly message: string
	readonly line?: number
}

export interface CompiledScript {
	/** JavaScript ready to run, or the input unchanged when it was already JS. */
	readonly code: string
	/** True when a transpiler ran (TypeScript input). */
	readonly transpiled: boolean
	readonly diagnostics: readonly Diagnostic[]
	readonly warnings: readonly string[]
	/** Literal phase names in source order. */
	readonly phases: readonly string[]
	/** Literal command names passed to world.run. */
	readonly commands: readonly string[]
}

/** Facade names injected into every script. */
export const FACADE_NAMES = [
	"agent",
	"phase",
	"world",
	"files",
	"git",
	"report",
	"artifact",
	"channel",
	"future",
	"log",
	"args",
	"run",
	"model",
	"sleep",
	"hole",
] as const

/** The function TypeScript input is transpiled inside. */
const BODY_NAME = "__opencode_workflow_body_9f3c"

/** Wrap a script body in the async function the engine calls. */
export function wrapScript(code: string, transpiled = false): string {
	const params = FACADE_NAMES.join(", ")
	if (transpiled) {
		// Transpilers treat top-level `return` as an error (module semantics), so
		// TypeScript input is compiled inside a named function and then called.
		return `"use strict";\nconst { ${params} } = __wf;\n${code}\nreturn ${BODY_NAME}();`
	}
	return `"use strict";\nconst { ${params} } = __wf;\nreturn (async () => {\n${code}\n})();`
}

/** Build the callable the engine invokes. Throws on syntax errors. */
export function buildScriptFunction(code: string, transpiled = false): (facade: Record<string, unknown>) => Promise<unknown> {
	// eslint-disable-next-line no-new-func
	return new Function("__wf", wrapScript(code, transpiled)) as (facade: Record<string, unknown>) => Promise<unknown>
}

interface BunTranspilerLike {
	transformSync(input: string): string
}

function bunTranspiler(): BunTranspilerLike | undefined {
	const runtime = (globalThis as { Bun?: { Transpiler?: new (options: Record<string, unknown>) => BunTranspilerLike } }).Bun
	if (!runtime?.Transpiler) return undefined
	try {
		return new runtime.Transpiler({ loader: "ts", target: "bun" })
	} catch {
		return undefined
	}
}

/** Strip `/* zcode-workflow`-style metadata headers from saved scripts. */
export function stripMetadataHeader(source: string): { body: string; metadata: Record<string, unknown> } {
	const match = source.match(/^\s*\/\*+\s*(?:workflow|opencode-workflow)\s*\r?\n([\s\S]*?)\*\//i)
	if (!match) return { body: source, metadata: {} }
	try {
		const parsed = JSON.parse(match[1])
		const metadata = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
		return { body: source.slice(match[0].length), metadata }
	} catch {
		return { body: source.slice(match[0].length), metadata: {} }
	}
}

function lineOf(source: string, index: number): number {
	let line = 1
	for (let i = 0; i < index && i < source.length; i++) if (source[i] === "\n") line++
	return line
}

function extractPhaseNames(source: string): string[] {
	const names: string[] = []
	const pattern = /\bphase\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1\s*\)/g
	for (const match of source.matchAll(pattern)) {
		const name = match[2]
		if (name && !names.includes(name)) names.push(name)
	}
	return names
}

function extractCommands(source: string): string[] {
	const commands: string[] = []
	const pattern = /\bworld\s*\.\s*run\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g
	for (const match of source.matchAll(pattern)) {
		const command = match[2]
		if (command && !commands.includes(command)) commands.push(command)
	}
	return commands
}

/**
 * Non-literal command names cannot be approved before the run, so they are
 * rejected. `world.run(foo, ...)` is a diagnostic; `world.run("git", args)` is
 * the supported form.
 */
function findNonLiteralCommands(source: string): number[] {
	const lines: number[] = []
	const pattern = /\bworld\s*\.\s*run\s*\(\s*/g
	for (const match of source.matchAll(pattern)) {
		let start = (match.index ?? 0) + match[0].length
		while (start < source.length && /\s/.test(source[start])) start++
		const first = source[start]
		if (first === '"' || first === "'") continue
		if (first === "`") {
			// A template literal is acceptable only when nothing is interpolated.
			const end = source.indexOf("`", start + 1)
			const body = end === -1 ? source.slice(start + 1) : source.slice(start + 1, end)
			if (body.includes("${")) lines.push(lineOf(source, match.index ?? 0))
			continue
		}
		lines.push(lineOf(source, match.index ?? 0))
	}
	return [...new Set(lines)]
}

function forbiddenConstructs(source: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = []
	const checks: Array<{ pattern: RegExp; message: string }> = [
		{ pattern: /^\s*import\s+[^\n(]/m, message: "import statements are not available in a workflow script." },
		{ pattern: /^\s*export\s+(?:default|const|function|class|interface|type)\b/m, message: "export statements are not available; a workflow's output is its final return value." },
		{ pattern: /\brequire\s*\(/, message: "require() is not available in a workflow script." },
		{ pattern: /\bprocess\s*\./, message: "process is not available in a workflow script; use world.run for commands." },
		{ pattern: /\bDate\s*\.\s*now\s*\(/, message: "Date.now() is not available; a resumed run must replay the same values." },
		{ pattern: /\bMath\s*\.\s*random\s*\(/, message: "Math.random() is not available; a resumed run must replay the same values." },
		{ pattern: /\bfetch\s*\(/, message: "fetch is not available in a workflow script; use world.run for network commands." },
	]
	for (const check of checks) {
		const match = check.pattern.exec(source)
		if (match) diagnostics.push({ message: check.message, line: lineOf(source, match.index) })
	}
	return diagnostics
}

/**
 * Compile a script body. TypeScript is accepted when the host runtime can
 * transpile it; otherwise the source must already be JavaScript.
 */
export function compileScript(source: string): CompiledScript {
	const trimmed = source.trim()
	if (!trimmed) {
		return { code: "", transpiled: false, diagnostics: [{ message: "The script is empty." }], warnings: [], phases: [], commands: [] }
	}

	let code = source
	let transpiled = false
	const diagnostics: Diagnostic[] = []
	const warnings: string[] = []

	const transpiler = bunTranspiler()
	if (transpiler) {
		try {
			code = transpiler.transformSync(`async function ${BODY_NAME}() {\n${source}\n}`)
			transpiled = true
		} catch (error) {
			diagnostics.push(...transpileDiagnostics(error))
			return { code: source, transpiled: false, diagnostics, warnings, phases: extractPhaseNames(source), commands: extractCommands(source) }
		}
	}

	for (const diagnostic of forbiddenConstructs(source)) diagnostics.push(diagnostic)

	if (!/\breturn\b/.test(source)) {
		warnings.push("The script has no return statement, so the run's result will be undefined.")
	}
	if (!extractPhaseNames(source).length) {
		warnings.push("The script calls no phase(). The run graph will be empty.")
	}

	if (!diagnostics.length) {
		try {
			// Compiling catches syntax errors the transpiler may not report.
			buildScriptFunction(code, transpiled)
		} catch (error) {
			diagnostics.push({ message: syntaxMessage(error) })
		}
	}

	for (const line of findNonLiteralCommands(source)) {
		diagnostics.push({
			message: "world.run's command must be a compile-time string literal; interpolate runtime values into the args array instead.",
			line,
		})
	}

	return {
		code,
		transpiled,
		diagnostics,
		warnings,
		phases: extractPhaseNames(source),
		commands: extractCommands(source),
	}
}

function transpileDiagnostics(error: unknown): Diagnostic[] {
	const candidate = error as { errors?: Array<{ message?: string; position?: { line?: number } | null }>; message?: string }
	if (Array.isArray(candidate?.errors) && candidate.errors.length) {
		return candidate.errors.map((entry) => ({
			message: entry.message ?? "TypeScript transpile failed.",
			line: entry.position?.line,
		}))
	}
	return [{ message: syntaxMessage(error) }]
}

function syntaxMessage(error: unknown): string {
	if (error instanceof Error) return `Syntax error: ${error.message}`
	return `Syntax error: ${String(error)}`
}
