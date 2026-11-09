/**
 * Saved workflows and durable run keys.
 *
 * A saved workflow is one file: a `/* workflow` JSON header, then the script
 * body. Project definitions live in `.opencode/workflows/<name>.wf.js` and are
 * committed with the repository; global ones live in
 * `~/.config/opencode/workflows/<name>.wf.js`.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { stripMetadataHeader } from "./compile.js"
import type { SavedWorkflowInfo } from "./types.js"

export const RUN_PREFIX = "workflow/run/"
export const RUN_INDEX_LIMIT = 100
export const NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

export interface SavedWorkflow {
	readonly info: SavedWorkflowInfo
	readonly body: string
}

export function projectWorkflowDir(root: string): string {
	return join(root, ".opencode", "workflows")
}

export function globalWorkflowDir(): string {
	return join(homedir(), ".config", "opencode", "workflows")
}

export function runStorageKey(id: string): string {
	return `${RUN_PREFIX}${id}`
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined
}

export function parseSaved(source: string, path: string, scope: "project" | "global"): SavedWorkflow | undefined {
	const { body, metadata } = stripMetadataHeader(source)
	const name = asString(metadata.name) ?? path.replace(/\.wf\.js$/, "").split("/").pop()
	const description = asString(metadata.description)
	if (!name || !description) return undefined
	const whenToUse = asString(metadata.whenToUse)
	const args = metadata.args && typeof metadata.args === "object" && !Array.isArray(metadata.args) ? (metadata.args as Record<string, unknown>) : undefined
	return {
		info: {
			name,
			description,
			...(whenToUse ? { whenToUse } : {}),
			scope,
			path,
			...(args ? { args } : {}),
			updatedAt: Number(metadata.updatedAt) || 0,
		},
		body,
	}
}

async function listDir(directory: string, scope: "project" | "global"): Promise<SavedWorkflow[]> {
	let names: string[]
	try {
		names = await readdir(directory)
	} catch {
		return []
	}
	const found: SavedWorkflow[] = []
	for (const name of names) {
		if (!name.endsWith(".wf.js")) continue
		const path = join(directory, name)
		try {
			const source = await readFile(path, "utf8")
			const parsed = parseSaved(source, path, scope)
			if (parsed) found.push(parsed)
		} catch {
			// unreadable definitions are skipped; one bad file must not hide the rest
		}
	}
	return found
}

export async function listSaved(root: string): Promise<SavedWorkflowInfo[]> {
	const [project, global] = await Promise.all([listDir(projectWorkflowDir(root), "project"), listDir(globalWorkflowDir(), "global")])
	const byName = new Map<string, SavedWorkflowInfo>()
	for (const entry of [...global, ...project]) byName.set(entry.info.name, entry.info)
	return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export async function loadSaved(root: string, name: string): Promise<SavedWorkflow | undefined> {
	if (!NAME_PATTERN.test(name)) throw new Error(`Invalid workflow name "${name}". Use letters, digits, dot, dash and underscore.`)
	const projectPath = join(projectWorkflowDir(root), `${name}.wf.js`)
	try {
		return parseSaved(await readFile(projectPath, "utf8"), projectPath, "project")
	} catch {
		// fall through to the global definition
	}
	const globalPath = join(globalWorkflowDir(), `${name}.wf.js`)
	try {
		return parseSaved(await readFile(globalPath, "utf8"), globalPath, "global")
	} catch {
		return undefined
	}
}

export async function saveSaved(
	root: string,
	input: {
		name: string
		description: string
		whenToUse?: string
		scope: "project" | "global"
		script: string
		args?: Record<string, unknown>
	},
): Promise<SavedWorkflowInfo> {
	if (!NAME_PATTERN.test(input.name)) throw new Error(`Invalid workflow name "${input.name}". Use letters, digits, dot, dash and underscore.`)
	const directory = input.scope === "project" ? projectWorkflowDir(root) : globalWorkflowDir()
	await mkdir(directory, { recursive: true })
	const path = join(directory, `${input.name}.wf.js`)
	const metadata = {
		name: input.name,
		description: input.description,
		...(input.whenToUse ? { whenToUse: input.whenToUse } : {}),
		...(input.args ? { args: input.args } : {}),
		updatedAt: Date.now(),
	}
	const source = `/* workflow\n${JSON.stringify(metadata, null, 2)}\n*/\n${input.script.trimEnd()}\n`
	await writeFile(path, source, "utf8")
	return {
		name: input.name,
		description: input.description,
		...(input.whenToUse ? { whenToUse: input.whenToUse } : {}),
		scope: input.scope,
		path: resolve(path),
		...(input.args ? { args: input.args } : {}),
		updatedAt: metadata.updatedAt,
	}
}
