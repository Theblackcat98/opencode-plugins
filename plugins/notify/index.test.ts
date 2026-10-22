import { rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { internals } from "./index.js"

describe("config resolution", () => {
	test("defaults to the shared ntfy topic", () => {
		const cfg = internals.resolveConfig({}, {})
		expect(cfg.server).toBe("https://ntfy.sh")
		expect(cfg.topic).toBe("theblackcat")
		expect(cfg.priority).toBe("default")
		expect(cfg.minDurationMs).toBe(0)
		expect(cfg.includeSubagents).toBe(false)
		expect(cfg.allLocations).toBe(false)
		expect(cfg.token).toBeUndefined()
	})

	test("plugin options win over environment variables", () => {
		const cfg = internals.resolveConfig(
			{ topic: "from-option", server: "https://ntfy.example.com" },
			{ OPENCODE_NTFY_TOPIC: "from-env", OPENCODE_NTFY_SERVER: "https://env.example.com" },
		)
		expect(cfg.topic).toBe("from-option")
		expect(cfg.server).toBe("https://ntfy.example.com")
	})

	test("environment variables win over the config file", () => {
		const cfg = internals.resolveConfig(
			{},
			{ OPENCODE_NTFY_TOPIC: "from-env" },
			{ topic: "from-file", server: "https://file.example.com" },
		)
		expect(cfg.topic).toBe("from-env")
		expect(cfg.server).toBe("https://file.example.com")
	})

	test("the config file is used when nothing else holds a value", () => {
		const cfg = internals.resolveConfig(
			{},
			{},
			{
				server: "https://file.example.com",
				topic: "from-file",
				token: "tk_file",
				priority: "high",
				minDurationSec: 120,
				includeSubagents: true,
				allLocations: true,
			},
		)
		expect(cfg.server).toBe("https://file.example.com")
		expect(cfg.topic).toBe("from-file")
		expect(cfg.token).toBe("tk_file")
		expect(cfg.priority).toBe("high")
		expect(cfg.minDurationMs).toBe(120_000)
		expect(cfg.includeSubagents).toBe(true)
		expect(cfg.allLocations).toBe(true)
	})

	test("environment variables are the fallback", () => {
		const cfg = internals.resolveConfig(
			{},
			{
				OPENCODE_NTFY_TOPIC: "env-topic",
				OPENCODE_NTFY_SERVER: "https://env.example.com",
				OPENCODE_NTFY_TOKEN: "tk_env",
				OPENCODE_NTFY_MIN_SECONDS: "300",
				OPENCODE_NTFY_PRIORITY: "high",
				OPENCODE_NTFY_INCLUDE_SUBAGENTS: "true",
				OPENCODE_NTFY_ALL_LOCATIONS: "true",
			},
		)
		expect(cfg.topic).toBe("env-topic")
		expect(cfg.server).toBe("https://env.example.com")
		expect(cfg.token).toBe("tk_env")
		expect(cfg.minDurationMs).toBe(300_000)
		expect(cfg.priority).toBe("high")
		expect(cfg.includeSubagents).toBe(true)
		expect(cfg.allLocations).toBe(true)
	})

	test("blank values are ignored", () => {
		const cfg = internals.resolveConfig({ topic: "   " }, { OPENCODE_NTFY_TOPIC: "" })
		expect(cfg.topic).toBe("theblackcat")
	})

	test("an unknown priority falls back to the default", () => {
		expect(internals.resolveConfig({ priority: "loud" }, {}).priority).toBe("default")
		expect(internals.resolveConfig({ priority: "HIGH" }, {}).priority).toBe("high")
	})

	test("booleans accept strings", () => {
		expect(internals.resolveConfig({ includeSubagents: "true" }, {}).includeSubagents).toBe(true)
		expect(internals.resolveConfig({ allLocations: "false" }, {}).allLocations).toBe(false)
	})
})

describe("config file", () => {
	test("the path comes from the option, the environment or the default", () => {
		expect(internals.resolveConfigFilePath({ configFile: "/tmp/one.json" }, {})).toBe("/tmp/one.json")
		expect(internals.resolveConfigFilePath({}, { OPENCODE_NTFY_CONFIG: "/tmp/two.json" })).toBe("/tmp/two.json")
		expect(internals.resolveConfigFilePath({}, { XDG_CONFIG_HOME: "/home/me/.config" })).toBe(
			"/home/me/.config/opencode/notify.json",
		)
	})

	test("a missing file holds no settings and is not an error", () => {
		const result = internals.readConfigFile("/tmp/notify-does-not-exist.json")
		expect(result.error).toBeUndefined()
		expect(result.values).toEqual({})
	})

	test("a valid file holds the settings", () => {
		const path = join(tmpdir(), `notify-config-${process.pid}.json`)
		writeFileSync(path, JSON.stringify({ server: "https://file.example.com", topic: "from-file" }))
		try {
			const result = internals.readConfigFile(path)
			expect(result.error).toBeUndefined()
			expect(result.values.topic).toBe("from-file")
		} finally {
			rmSync(path, { force: true })
		}
	})

	test("a broken file is reported and holds no settings", () => {
		const path = join(tmpdir(), `notify-config-broken-${process.pid}.json`)
		writeFileSync(path, "{ not json")
		try {
			const result = internals.readConfigFile(path)
			expect(result.error).toContain("not valid JSON")
			expect(result.values).toEqual({})
		} finally {
			rmSync(path, { force: true })
		}
	})

	test("a file that is not an object is reported", () => {
		const path = join(tmpdir(), `notify-config-array-${process.pid}.json`)
		writeFileSync(path, "[1, 2, 3]")
		try {
			const result = internals.readConfigFile(path)
			expect(result.error).toContain("JSON object")
			expect(result.values).toEqual({})
		} finally {
			rmSync(path, { force: true })
		}
	})
})

describe("endpoint resolution", () => {
	test("the topic URL is used", () => {
		const cfg = internals.resolveConfig({}, {})
		expect(internals.resolveEndpoint(cfg)).toBe("https://ntfy.sh/theblackcat")
	})

	test("a path prefix is kept for a self hosted server", () => {
		const cfg = internals.resolveConfig({ server: "https://example.com/ntfy/" }, {})
		expect(internals.resolveEndpoint(cfg)).toBe("https://example.com/ntfy/theblackcat")
	})

	test("a broken server URL is rejected", () => {
		const cfg = internals.resolveConfig({ server: "not a url" }, {})
		expect(() => internals.resolveEndpoint(cfg)).toThrow(/invalid ntfy server URL/)
	})

	test("a non http server URL is rejected", () => {
		const cfg = internals.resolveConfig({ server: "ftp://example.com" }, {})
		expect(() => internals.resolveEndpoint(cfg)).toThrow(/must be http/)
	})

	test("an invalid topic is rejected", () => {
		const cfg = internals.resolveConfig({ topic: "with space" }, {})
		expect(() => internals.resolveEndpoint(cfg)).toThrow(/invalid ntfy topic/)
	})
})

describe("duration formatting", () => {
	test("seconds, minutes and hours", () => {
		expect(internals.formatDuration(4_200)).toBe("4s")
		expect(internals.formatDuration(65_000)).toBe("1m 05s")
		expect(internals.formatDuration(754_000)).toBe("12m 34s")
		expect(internals.formatDuration(3_600_000)).toBe("1h 00m")
		expect(internals.formatDuration(7_260_000)).toBe("2h 01m")
	})

	test("an unknown duration is reported as such", () => {
		expect(internals.formatDuration(undefined)).toBe("unknown")
		expect(internals.formatDuration(-1)).toBe("unknown")
	})
})

describe("run description", () => {
	test("the outcome and the duration are in the message", () => {
		const text = internals.describeRun({ title: "Chat", outcome: "succeeded", durationMs: 120_000 })
		expect(text).toBe("Generation finished in 2m 00s.")
	})

	test("a failure carries the error", () => {
		const text = internals.describeRun({
			title: "Chat",
			outcome: "failed",
			durationMs: 1_000,
			detail: "rate limited",
		})
		expect(text).toContain("Generation failed in 1s.")
		expect(text).toContain("rate limited")
	})

	test("the directory is the last line", () => {
		const text = internals.describeRun({
			title: "Chat",
			outcome: "succeeded",
			durationMs: 1_000,
			directory: "/home/nick/projects/foo",
		})
		expect(text.split("\n")).toEqual(["Generation finished in 1s.", "/home/nick/projects/foo"])
	})
})

describe("payload", () => {
	test("the chat title becomes the notification title", () => {
		const payload = internals.buildPayload({ title: "Fix the plugin bug", outcome: "succeeded" })
		expect(payload.title).toBe("Fix the plugin bug")
		expect(payload.message).toContain("Generation finished")
		expect(payload.tags).toEqual(["white_check_mark"])
	})

	test("a session without a title still gets one", () => {
		expect(internals.resolveTitle(undefined)).toBe("OpenCode chat")
		expect(internals.resolveTitle("   ")).toBe("OpenCode chat")
		expect(internals.resolveTitle("  Chat  ")).toBe("Chat")
	})
})

describe("headers", () => {
	test("the title, priority and tags are headers", () => {
		const cfg = internals.resolveConfig({ priority: "high" }, {})
		const headers = internals.buildHeaders(cfg, internals.buildPayload({ title: "Chat", outcome: "failed" }))
		expect(headers.Title).toBe("Chat")
		expect(headers.Priority).toBe("high")
		expect(headers.Tags).toBe("x")
		expect(headers.Authorization).toBeUndefined()
	})

	test("a token adds the authorization header", () => {
		const cfg = internals.resolveConfig({ token: "tk_123" }, {})
		const headers = internals.buildHeaders(cfg, internals.buildPayload({ title: "Chat", outcome: "succeeded" }))
		expect(headers.Authorization).toBe("Bearer tk_123")
	})

	test("a plain ASCII title is sent as it is", () => {
		expect(internals.encodeHeaderValue("Fix the plugin bug")).toBe("Fix the plugin bug")
	})

	test("a title with non ASCII text is RFC 2047 encoded", () => {
		const encoded = internals.encodeHeaderValue("Café — naïve")
		expect(encoded.startsWith("=?UTF-8?B?")).toBe(true)
		expect(encoded.endsWith("?=")).toBe(true)
		expect(Buffer.from(encoded.slice(10, -2), "base64").toString("utf8")).toBe("Café — naïve")
	})
})

describe("session ownership", () => {
	test("the project id is the exact owner", () => {
		expect(
			internals.ownsSession(
				{ projectID: "p1", directories: ["/home/nick/projects/foo"] },
				{ projectID: "p1", directory: "/home/nick/projects/foo" },
			),
		).toBe(true)
	})

	test("another project is not owned, even in a subdirectory", () => {
		expect(
			internals.ownsSession(
				{ projectID: "p1", directories: ["/home/nick"] },
				{ projectID: "p2", directory: "/home/nick/projects/foo" },
			),
		).toBe(false)
	})

	test("the directory is the fallback when a project id is missing", () => {
		expect(
			internals.ownsSession(
				{ projectID: "p1", directories: ["/home/nick/projects/foo"] },
				{ directory: "/home/nick/projects/foo" },
			),
		).toBe(true)
		expect(
			internals.ownsSession(
				{ directories: ["/home/nick/projects/foo"] },
				{ directory: "/home/nick/projects/bar" },
			),
		).toBe(false)
	})
})

describe("location filter", () => {
	test("the same directory matches", () => {
		expect(internals.coversDirectory(["/home/nick/projects/foo"], "/home/nick/projects/foo")).toBe(true)
	})

	test("a trailing slash does not matter", () => {
		expect(internals.coversDirectory(["/home/nick/projects/foo/"], "/home/nick/projects/foo")).toBe(true)
	})

	test("a subdirectory of the location matches", () => {
		expect(internals.coversDirectory(["/home/nick/projects/foo"], "/home/nick/projects/foo/sub")).toBe(true)
	})

	test("another project does not match", () => {
		expect(internals.coversDirectory(["/home/nick/projects/foo"], "/home/nick/projects/bar")).toBe(false)
	})

	test("a sibling with a shared prefix does not match", () => {
		expect(internals.coversDirectory(["/home/nick/projects/foo"], "/home/nick/projects/foobar")).toBe(false)
	})

	test("an unknown directory never matches", () => {
		expect(internals.coversDirectory(["/home/nick/projects/foo"], undefined)).toBe(false)
		expect(internals.coversDirectory([undefined], "/home/nick/projects/foo")).toBe(false)
	})
})

describe("minimum run length", () => {
	test("every run is reported when no minimum is set", () => {
		expect(internals.shouldNotify(0, 0)).toBe(true)
		expect(internals.shouldNotify(undefined, 0)).toBe(true)
	})

	test("short runs are skipped when a minimum is set", () => {
		expect(internals.shouldNotify(1_000, 60_000)).toBe(false)
		expect(internals.shouldNotify(undefined, 60_000)).toBe(false)
	})

	test("a run at the minimum is reported", () => {
		expect(internals.shouldNotify(60_000, 60_000)).toBe(true)
	})
})
