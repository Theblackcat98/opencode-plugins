/**
 * OpenCode Go usage — server half.
 *
 * Deliberately inert. The usage card is a terminal-client concern: the TUI half
 * resolves the credential through the OpenCode client and calls the Go usage
 * endpoint itself, so nothing needs to run server-side. This file exists because
 * a plugin directory is loaded as one unit, with both entrypoints together.
 */

import { Plugin } from "@opencode/plugin"

export default Plugin.define({
	id: "opencode-go-usage",
	setup() {},
})
