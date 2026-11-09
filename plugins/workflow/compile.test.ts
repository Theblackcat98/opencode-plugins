import { describe, expect, test } from "bun:test"
import { compileScript, stripMetadataHeader } from "./compile.js"

describe("compileScript", () => {
	test("extracts phase names and world.run commands", () => {
		const compiled = compileScript(`
phase("Survey")
const files = await files.glob("src/**/*.ts")
phase("Check tests")
const result = await world.run("npm", ["test"])
return { ok: result.exitCode === 0 }
`)
		expect(compiled.diagnostics).toEqual([])
		expect(compiled.phases).toEqual(["Survey", "Check tests"])
		expect(compiled.commands).toEqual(["npm"])
	})

	test("rejects a computed world.run command", () => {
		const compiled = compileScript(`
const cmd = "npm"
const result = await world.run(cmd, ["test"])
return result.exitCode
`)
		expect(compiled.diagnostics.some((diagnostic) => diagnostic.message.includes("compile-time string literal"))).toBe(true)
	})

	test("rejects forbidden globals", () => {
		const compiled = compileScript(`return fetch("https://example.com")`)
		expect(compiled.diagnostics.some((diagnostic) => diagnostic.message.includes("fetch"))).toBe(true)
	})

	test("reports a syntax error instead of throwing", () => {
		const compiled = compileScript(`phase("Broken"\nreturn 1`)
		expect(compiled.diagnostics.length).toBeGreaterThan(0)
	})

	test("warns about a missing return", () => {
		const compiled = compileScript(`phase("Only one")\nawait world.run("true")`)
		expect(compiled.warnings.some((warning) => warning.includes("no return"))).toBe(true)
	})

	test("warns about a missing phase", () => {
		const compiled = compileScript(`return 1`)
		expect(compiled.warnings.some((warning) => warning.includes("phase()"))).toBe(true)
	})
})

describe("stripMetadataHeader", () => {
	test("parses the JSON header and leaves the body", () => {
		const source = `/* workflow\n{"name":"review","description":"Review"}\n*/\nreturn 1\n`
		const parsed = stripMetadataHeader(source)
		expect(parsed.metadata.name).toBe("review")
		expect(parsed.body.trim()).toBe("return 1")
	})

	test("returns the source unchanged when there is no header", () => {
		const parsed = stripMetadataHeader("return 1")
		expect(parsed.metadata).toEqual({})
		expect(parsed.body).toBe("return 1")
	})
})
