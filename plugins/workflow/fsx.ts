/**
 * The `files.*` and `git.*` halves of the facade.
 *
 * Walks are bounded and reject rather than return a silently partial view, the
 * same rule the ZCode facade uses. `git.*` shells out to git so a missing
 * repository, or a missing binary, is a catchable rejection.
 */

import { readdir, readFile, stat } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import { runProcess } from "./exec.js"

export const GLOB_LIMIT = 2000
export const GREP_MATCH_LIMIT = 2000
export const GREP_TEXT_LIMIT = 256 * 1024
export const READ_LIMIT = 2 * 1024 * 1024
export const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", "dist", "build", ".next", ".turbo", ".cache", "coverage"])

/** Expand `{a,b}` alternatives; nested braces are handled recursively. */
export function expandBraces(pattern: string): string[] {
	const start = pattern.indexOf("{")
	if (start === -1) return [pattern]
	let depth = 0
	let end = -1
	for (let i = start; i < pattern.length; i++) {
		if (pattern[i] === "{") depth++
		else if (pattern[i] === "}") {
			depth--
			if (depth === 0) {
				end = i
				break
			}
		}
	}
	if (end === -1) return [pattern]
	const head = pattern.slice(0, start)
	const body = pattern.slice(start + 1, end)
	const tail = pattern.slice(end + 1)
	const options: string[] = []
	let current = ""
	let inner = 0
	for (const char of body) {
		if (char === "," && inner === 0) {
			options.push(current)
			current = ""
			continue
		}
		if (char === "{") inner++
		if (char === "}") inner--
		current += char
	}
	options.push(current)
	return options.flatMap((option) => expandBraces(`${head}${option}${tail}`))
}

/** Convert a POSIX glob to a RegExp. Supports `**`, `*`, `?`, classes and braces. */
export function globToRegExp(pattern: string): RegExp {
	const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "")
	let source = ""
	for (let i = 0; i < normalized.length; i++) {
		const char = normalized[i]
		if (char === "*") {
			const isDouble = normalized[i + 1] === "*"
			if (isDouble) {
				const after = normalized[i + 2]
				if (after === "/") {
					source += "(?:[^/]+/)*"
					i += 2
				} else {
					source += ".*"
					i += 1
				}
			} else {
				source += "[^/]*"
			}
			continue
		}
		if (char === "?") {
			source += "[^/]"
			continue
		}
		if (char === "[") {
			const end = normalized.indexOf("]", i + 1)
			if (end !== -1) {
				source += normalized.slice(i, end + 1)
				i = end
				continue
			}
		}
		source += char.replace(/[.+^${}()|\\]/g, "\\$&")
	}
	return new RegExp(`^${source}$`)
}

export function matchGlob(path: string, pattern: string): boolean {
	return globToRegExp(pattern).test(path.replaceAll("\\", "/"))
}

async function walk(root: string, onFile: (absolute: string, rel: string) => Promise<boolean> | boolean): Promise<boolean> {
	const queue: string[] = [root]
	while (queue.length) {
		const current = queue.pop()
		if (!current) continue
		let entries
		try {
			entries = await readdir(current, { withFileTypes: true })
		} catch {
			continue
		}
		for (const entry of entries) {
			const absolute = join(current, entry.name)
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name)) continue
				queue.push(absolute)
				continue
			}
			if (!entry.isFile()) continue
			const rel = relative(root, absolute).split(sep).join("/")
			const keepGoing = await onFile(absolute, rel)
			if (keepGoing === false) return false
		}
	}
	return true
}

export async function globFiles(root: string, patterns: readonly string[], limit = GLOB_LIMIT): Promise<string[]> {
	const expanded = patterns.flatMap(expandBraces).map(globToRegExp)
	const matches: string[] = []
	await walk(root, (_absolute, rel) => {
		if (expanded.some((re) => re.test(rel))) {
			matches.push(rel)
			if (matches.length > limit) return false
		}
		return true
	})
	if (matches.length > limit) throw new Error(`files.glob matched more than ${limit} files. Narrow the pattern.`)
	return matches.sort()
}

export async function readText(root: string, path: string): Promise<string> {
	const base = resolve(root)
	const absolute = resolve(base, path)
	if (absolute !== base && !absolute.startsWith(base + sep)) {
		throw new Error(`files.read: ${path} is outside the workspace.`)
	}
	const info = await stat(absolute)
	if (!info.isFile()) throw new Error(`files.read: ${path} is not a file.`)
	if (info.size > READ_LIMIT) throw new Error(`files.read: ${path} is larger than ${READ_LIMIT} bytes.`)
	return readFile(absolute, "utf8")
}

export interface GrepMatch {
	readonly path: string
	readonly line: number
	readonly text: string
}

export async function grepFiles(root: string, pattern: string, glob?: string): Promise<GrepMatch[]> {
	const re = new RegExp(pattern)
	const matches: GrepMatch[] = []
	let textBytes = 0
	let overflow = false
	const paths = glob ? await globFiles(root, [glob]) : await globFiles(root, ["**/*"])
	for (const path of paths) {
		if (overflow) break
		const absolute = join(root, path)
		let info
		try {
			info = await stat(absolute)
		} catch {
			continue
		}
		if (!info.isFile() || info.size > READ_LIMIT) continue
		let content: string
		try {
			content = await readFile(absolute, "utf8")
		} catch {
			continue
		}
		if (content.includes("\u0000")) continue
		const lines = content.split("\n")
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index]
			if (!re.test(line)) continue
			matches.push({ path, line: index + 1, text: line })
			textBytes += Buffer.byteLength(line, "utf8")
			if (matches.length > GREP_MATCH_LIMIT || textBytes > GREP_TEXT_LIMIT) {
				overflow = true
				break
			}
		}
	}
	if (overflow) throw new Error(`files.grep exceeded ${GREP_MATCH_LIMIT} matches or ${GREP_TEXT_LIMIT} bytes. Narrow the pattern or glob.`)
	return matches
}

async function git(root: string, args: readonly string[]): Promise<string> {
	const result = await runProcess("git", args, { cwd: root, output: { tail: 512 * 1024 } })
	if (result.exitCode !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `git exited ${result.exitCode}`
		throw new Error(detail)
	}
	return result.stdout
}

export interface GitStatus {
	readonly branch?: string
	readonly clean: boolean
	readonly staged: string[]
	readonly unstaged: string[]
	readonly untracked: string[]
}

export async function gitStatus(root: string): Promise<GitStatus> {
	const porcelain = await git(root, ["status", "--porcelain=v1", "--branch"])
	const staged: string[] = []
	const unstaged: string[] = []
	const untracked: string[] = []
	let branch: string | undefined
	for (const line of porcelain.split("\n")) {
		if (!line.trim()) continue
		if (line.startsWith("## ")) {
			const rest = line.slice(3).trim()
			branch = rest.startsWith("No commits yet on ") ? rest.slice("No commits yet on ".length) : rest.split("...")[0]
			continue
		}
		const index = line[0]
		const worktree = line[1]
		const path = line.slice(3).trim()
		if (index === "?" && worktree === "?") untracked.push(path)
		else {
			if (index !== " " && index !== "?") staged.push(path)
			if (worktree !== " " && worktree !== "?") unstaged.push(path)
		}
	}
	return { branch, clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0, staged, unstaged, untracked }
}

export async function gitChangedFiles(root: string, base?: string): Promise<string[]> {
	if (base) {
		const out = await git(root, ["diff", "--name-only", base])
		return out.split("\n").map((line) => line.trim()).filter(Boolean)
	}
	const status = await gitStatus(root)
	return [...new Set([...status.staged, ...status.unstaged, ...status.untracked])].sort()
}

export async function gitDiff(root: string, base = "HEAD", path?: string): Promise<string> {
	const args = ["diff", base]
	if (path) args.push("--", path)
	const result = await runProcess("git", args, { cwd: root, output: { tail: 512 * 1024 } })
	if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git diff exited ${result.exitCode}`)
	return result.stdout
}

export interface GitCommit {
	readonly hash: string
	readonly subject: string
	readonly author: string
	readonly date: string
}

export async function gitLog(root: string, count = 20): Promise<GitCommit[]> {
	const capped = Math.max(1, Math.min(count, 100))
	const out = await git(root, ["log", `-${capped}`, "--pretty=format:%H%x09%s%x09%an%x09%aI"])
	return out
		.split("\n")
		.map((line) => line.split("\t"))
		.filter((parts) => parts.length >= 4)
		.map((parts) => ({ hash: parts[0], subject: parts[1], author: parts[2], date: parts[3] }))
}
