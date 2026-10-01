/**
 * Host half of `dsh-plugin-publisher`.
 *
 * Registers two tools the agent calls directly:
 *
 *   check_plugin    validate a plugin directory (read-only, contacts nothing)
 *   publish_plugin  create the GitHub repository and upload the tree
 *
 * ## Why there is no browser half
 *
 * This plugin exists for the agent to use. The agent writes plugins, so the agent
 * should publish them — and a tool is how an agent acts. An earlier version
 * shipped a settings page, which meant a human copying a path and pressing a
 * button; that manual step is the thing being removed, so the page is gone along
 * with `lib/client.js` and the route surface it needed.
 *
 * ## No `@deepseek-ai/*` imports
 *
 * Those packages are not resolvable from a plugin here (verified:
 * `ERR_MODULE_NOT_FOUND` for `dsh-tools`, `dsh-credentials` and the rest). Every
 * capability is reached through `ctx`:
 *
 *   ctx.tools        register the tool definitions
 *   ctx.subprocess   run git
 *   ctx.credentials  resolve the stored GitHub token
 *
 * The tool schemas are therefore written as raw JSON Schema rather than through
 * `defineTool`; see `lib/tool.js` for what that costs and how it is covered.
 *
 * @module dsh-plugin-publisher
 */

import { publishTool, checkTool, findToken, PUBLISH_TOOL, CHECK_TOOL } from './tool.js';

/** Stable plugin name. */
export const name = 'dsh-plugin-publisher';

/**
 * Required services.
 *
 * `tools` is a hard dependency: without a registry there is nothing to register
 * and the plugin has no reason to activate. `subprocess` and `credentials` are
 * read with `ctx.get()` at call time instead, so a missing one produces a clear
 * message in the tool result rather than a plugin that refuses to load.
 */
export const inject = ['tools'];

/**
 * The plugin config.
 *
 * ## Why no `Config` schema is exported
 *
 * Cordis validates a plugin's config through `runtime.Config["~standard"].validate`,
 * which requires a **Standard Schema** — an object carrying a `~standard` property.
 * A plain JSON Schema has no such property, so exporting one leaves
 * `Config["~standard"]` undefined and the plugin FAILS TO LOAD with
 * `Cannot read properties of undefined (reading 'validate')`.
 *
 * A Standard Schema normally comes from a schema library (`schemastery`, `zod`),
 * and neither is importable from a plugin here. So nothing is exported — which is
 * exactly what the other working plugins in this profile do — and the two settings
 * that matter are read from the loader config and the environment instead.
 *
 * The cost is that a profile cannot type-check these fields. That is acceptable:
 * both are optional, and the token has two better homes anyway (the credential
 * store and the environment).
 *
 * @param config - the unvalidated loader config, when a profile supplies one.
 * @returns `{ token, owner }`, either possibly undefined.
 */
function readConfig(config) {
	// Every field is checked, because with no schema declared Cordis hands the raw
	// value through unvalidated.
	const raw = config !== null && typeof config === 'object' ? config : {};
	return {
		token: typeof raw.token === 'string' && raw.token.trim().length > 0 ? raw.token.trim() : undefined,
		owner: typeof raw.owner === 'string' && raw.owner.trim().length > 0 ? raw.owner.trim() : undefined
	};
}

/**
 * Install the Host half.
 *
 * @param ctx - plugin context carrying the tool registry.
 * @param config - unvalidated loader config, when a profile supplies one.
 */
export function apply(ctx, config) {
	ctx.tools.register(publishTool(ctx, readConfig(config)));
	ctx.tools.register(checkTool(ctx));
}

export { PUBLISH_TOOL, CHECK_TOOL, findToken };
