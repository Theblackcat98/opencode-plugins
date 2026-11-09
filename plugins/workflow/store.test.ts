import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listSaved, loadSaved, saveSaved } from "./store.js"

const temporary: string[] = []

async function tempDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "workflow-test-"))
	temporary.push(directory)
	return directory
}

afterEach(async () => {
	for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe("saved workflows", () => {
	test("saves, lists and loads a project definition", async () => {
		const root = await tempDir()
		const info = await saveSaved(root, {
			name: "review",
			description: "Review changed files",
			whenToUse: "A pull request needs review",
			scope: "project",
			script: `phase("Review")\nreturn await agent("reviewer").ask("review")`,
			args: { pr: { type: "string", required: true } },
		})
		expect(info.scope).toBe("project")
		expect(info.path.startsWith(root)).toBe(true)

		const saved = await loadSaved(root, "review")
		expect(saved?.info.name).toBe("review")
		expect(saved?.info.description).toBe("Review changed files")
		expect(saved?.body.trim().startsWith('phase("Review")')).toBe(true)

		const listed = await listSaved(root)
		expect(listed.some((entry) => entry.name === "review" && entry.scope === "project")).toBe(true)
	})

	test("rejects an unsafe name", async () => {
		const root = await tempDir()
		await expect(
			saveSaved(root, { name: "../escape", description: "x", scope: "project", script: "return 1" }),
		).rejects.toThrow("Invalid workflow name")
	})

	test("returns undefined for an unknown name", async () => {
		const root = await tempDir()
		expect(await loadSaved(root, "missing")).toBeUndefined()
	})
})
