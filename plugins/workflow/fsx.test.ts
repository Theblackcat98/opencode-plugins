import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expandBraces, globFiles, globToRegExp, readText } from "./fsx.js"

const temporary: string[] = []

async function tempDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "workflow-fsx-"))
	temporary.push(directory)
	return directory
}

afterEach(async () => {
	for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe("glob helpers", () => {
	test("expands brace alternatives", () => {
		expect(expandBraces("src/*.{ts,tsx}")).toEqual(["src/*.ts", "src/*.tsx"])
		expect(expandBraces("a/{b,c{d,e}}")).toEqual(["a/b", "a/cd", "a/ce"])
	})

	test("matches ** across directories but * only within one", () => {
		const deep = globToRegExp("src/**/*.ts")
		expect(deep.test("src/a.ts")).toBe(true)
		expect(deep.test("src/x/y/a.ts")).toBe(true)
		expect(deep.test("lib/a.ts")).toBe(false)

		const flat = globToRegExp("src/*.ts")
		expect(flat.test("src/a.ts")).toBe(true)
		expect(flat.test("src/x/a.ts")).toBe(false)
	})

	test("walks files and skips ignored directories", async () => {
		const root = await tempDir()
		await mkdir(join(root, "src", "nested"), { recursive: true })
		await mkdir(join(root, "node_modules", "pkg"), { recursive: true })
		await writeFile(join(root, "src", "a.ts"), "a")
		await writeFile(join(root, "src", "nested", "b.ts"), "b")
		await writeFile(join(root, "node_modules", "pkg", "c.ts"), "c")
		const found = await globFiles(root, ["**/*.ts"])
		expect(found).toEqual(["src/a.ts", "src/nested/b.ts"])
	})

	test("readText rejects a path outside the workspace", async () => {
		const root = await tempDir()
		await expect(readText(root, "../escape.txt")).rejects.toThrow("outside the workspace")
	})
})
