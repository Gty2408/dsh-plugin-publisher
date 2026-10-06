/**
 * The `publish_plugin` tool definition.
 *
 * ## Why a tool rather than a settings page
 *
 * This plugin exists to be used BY the agent, not by a person. The agent is the
 * one that writes plugins, so the agent is the one that should publish them —
 * and a tool is how an agent acts. A settings page would mean a human copying a
 * path and pressing a button, which is exactly the manual step this removes.
 *
 * ## Why the definition is built by hand
 *
 * First-party tools use `defineTool` from `@deepseek-ai/dsh-tools`, which turns a
 * concise parameter spec into JSON Schema and validates arguments. That package is
 * NOT importable from a plugin in this deployment (verified:
 * `ERR_MODULE_NOT_FOUND`), so the JSON Schema is written out directly. The
 * registry accepts a raw schema — `tools.register()` only requires
 * `output.render` to be a function and the schema to be supported.
 *
 * Writing the schema by hand has one real cost: the registry no longer validates
 * arguments for us, so `execute` must check its own inputs. That is done in
 * `readArgs` below, and it matters more than usual here because a bad argument
 * means creating a PUBLIC repository under the user's account.
 *
 * @module dsh-plugin-publisher/tool
 */

import { publish, inspect } from './publish.js';

/** Tool name. Exported so tests and docs cannot drift from the registration. */
export const PUBLISH_TOOL = 'publish_plugin';

/** Tool name for the read-only check. */
export const CHECK_TOOL = 'check_plugin';

/**
 * One argument's schema.
 *
 * @param type - JSON Schema type.
 * @param description - model-facing description.
 * @param extra - additional schema keywords.
 * @returns the schema node.
 */
export function arg(type, description, extra = {}) {
	return { type, description, ...extra };
}

/** The directory argument, shared by every tool that takes one. */
export const DIRECTORY_ARG = arg('string', 'Absolute path to the plugin package root (the directory containing package.json).');

/** The publish tool's parameters. */
const PUBLISH_PARAMETERS = {
	type: 'object',
	properties: {
		directory: DIRECTORY_ARG,
		owner: arg('string', 'GitHub account that will own the repository. Defaults to the account the stored token belongs to.'),
		repo: arg('string', 'Repository name. Defaults to the package name in package.json.'),
		description: arg(
			'string',
			'One-line repository description. Defaults to the package.json description. Must not be marketing copy.'
		),
		private: arg('boolean', 'Create the repository as private instead of public. Defaults to false.'),
		replace_existing: arg(
			'boolean',
			'Overwrite a branch that already has commits. Defaults to false: without it, an upload that would discard existing work is refused and nothing is changed.'
		),
		submit: arg(
			'boolean',
			'Also open a pull request to the plugin marketplace. Defaults to false — publishing for personal use does not need it.'
		),
		category: arg('string', 'Marketplace category. Only used when submit is true.')
	},
	required: ['directory']
};

/** The check tool's parameters. */
const CHECK_PARAMETERS = {
	type: 'object',
	properties: {
		directory: DIRECTORY_ARG,
		owner: arg('string', 'GitHub owner, so the report can check the repository field.'),
		repo: arg('string', 'Repository name, so the report can check the repository field.')
	},
	required: ['directory']
};

/**
 * The declared result shape.
 *
 * Deliberately loose (`additionalProperties: true`): the value carries a step
 * list whose length depends on how far the flow got, and pinning it down would
 * mean restating the flow's control structure in a schema.
 */
export const RESULT_SCHEMA = {
	type: 'object',
	properties: {
		ok: { type: 'boolean', description: 'Whether the operation completed.' },
		steps: { type: 'array', description: 'One record per step, in order.', items: { type: 'object', additionalProperties: true } },
		published: { type: 'object', additionalProperties: true, description: 'The repository, when one was published.' },
		error: { type: 'string', description: 'A top-level failure message, when the request never ran.' }
	},
	required: ['ok'],
	additionalProperties: true
};

/**
 * Render a result as model-facing text.
 *
 * The step list is the point: a partial failure must say exactly how far the flow
 * got, because the irreversible parts (a created repository) cannot be undone by
 * retrying.
 *
 * @param value - the tool's value.
 * @returns content blocks.
 */
export function renderResult(value) {
	const lines = [];
	if (value.error !== undefined) lines.push(`Error: ${String(value.error)}`);

	for (const item of value.steps ?? []) {
		const mark = item.status === 'ok' ? 'OK  ' : item.status === 'warn' ? 'WARN' : item.status === 'skipped' ? '--  ' : 'FAIL';
		lines.push(`${mark}  ${String(item.name).padEnd(12)} ${String(item.detail ?? item.status)}`);
	}

	if (value.published?.htmlUrl !== undefined) lines.push('', `Repository: ${String(value.published.htmlUrl)}`);
	if (Array.isArray(value.published?.topics) && value.published.topics.length > 0) {
		lines.push(`Topics: ${value.published.topics.join(', ')}`);
	}
	if (value.pullRequest?.htmlUrl !== undefined) lines.push(`Listing pull request: ${String(value.pullRequest.htmlUrl)}`);

	// The install commands are the reason the repository exists, so they are always
	// shown — and BOTH forms, because which one works depends on the installing
	// machine. The `github:` form is resolved through git; the codeload URL is
	// fetched over plain HTTPS and needs no git at all. On a network where
	// `github.com` is unreliable (measured here: 6 of 20 attempts), the second is
	// the one that works, so offering only the first strands the user.
	if (value.ok === true && value.published?.fullName !== undefined) {
		const fullName = String(value.published.fullName);
		lines.push(
			'',
			'Install on another machine — either of these:',
			`  dsh plugin --profile desktop add github:${fullName}`,
			'      (resolved through git; that machine needs git installed)',
			'',
			`  dsh plugin --profile desktop add https://codeload.github.com/${fullName}/tar.gz/HEAD`,
			'      (fetched over HTTPS; needs no git)'
		);
		if (typeof value.published.commit === 'string' && value.published.commit.length >= 7) {
			lines.push(
				'',
				'To install exactly this version rather than whatever HEAD becomes:',
				`  dsh plugin --profile desktop add https://codeload.github.com/${fullName}/tar.gz/${value.published.commit}`
			);
		}
	}

	if (Array.isArray(value.findings) && value.findings.length > 0) {
		lines.push('', 'Findings:');
		for (const finding of value.findings) {
			lines.push(`  [${finding.level}] ${finding.message}`);
			if (finding.hint !== undefined) lines.push(`         ${finding.hint}`);
		}
	}

	return [{ type: 'text', text: lines.join('\n').trim() || 'Done.' }];
}

/**
 * Validate and normalise the arguments.
 *
 * The registry does not validate for us (see the module comment), and a mistake
 * here creates a public repository — so every field is checked rather than
 * coerced. An unknown key is rejected rather than ignored, so a typo cannot
 * silently publish to the wrong place.
 *
 * @param args - the raw tool arguments.
 * @param allowed - the accepted keys.
 * @param options - which keys are strings and which are booleans. Defaults to the
 *   publish tool's split, which is what the two original tools use.
 * @returns `{ value }` or `{ error }`.
 */
export function readArgs(args, allowed, options = {}) {
	const stringKeys = options.strings ?? ['owner', 'repo', 'description', 'category'];
	const booleanKeys = options.booleans ?? ['private', 'submit'];
	if (args === null || typeof args !== 'object' || Array.isArray(args)) {
		return { error: 'The arguments must be an object.' };
	}
	for (const key of Object.keys(args)) {
		if (!allowed.includes(key)) return { error: `Unknown argument "${key}". Accepted: ${allowed.join(', ')}.` };
	}

	const directory = args.directory;
	if (typeof directory !== 'string' || directory.trim().length === 0) {
		return { error: 'A "directory" is required: the absolute path to the plugin package root.' };
	}

	const out = { directory: directory.trim() };
	for (const key of stringKeys) {
		const value = args[key];
		if (value === undefined) continue;
		if (typeof value !== 'string') return { error: `"${key}" must be a string.` };
		if (value.trim().length > 0) out[key] = value.trim();
	}
	for (const key of booleanKeys) {
		const value = args[key];
		if (value === undefined) continue;
		if (typeof value !== 'boolean') return { error: `"${key}" must be true or false.` };
		out[key] = value;
	}
	if (Array.isArray(options.arrays)) {
		for (const key of options.arrays) {
			const value = args[key];
			if (value === undefined) continue;
			if (!Array.isArray(value)) return { error: `"${key}" must be an array of strings.` };
			for (const entry of value) {
				if (typeof entry !== 'string') return { error: `"${key}" must contain only strings.` };
			}
			if (value.length > 0) out[key] = value.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
		}
	}
	return { value: out };
}

/**
 * Resolve the GitHub token.
 *
 * Order matters: the plugin config wins, so a profile can pin a specific account,
 * and the credential store is the fallback the settings-free path relies on.
 *
 * @param ctx - plugin context.
 * @param config - the validated plugin config.
 * @returns the token, or undefined.
 */
export async function findToken(ctx, config) {
	if (typeof config?.token === 'string' && config.token.trim().length > 0) return config.token.trim();

	// The Host credential store: what the earlier settings page wrote, and what an
	// environment variable named DSH_GITHUB_TOKEN resolves through.
	const credentials = ctx.get('credentials');
	if (credentials !== undefined) {
		try {
			const hit = await credentials.resolve('DSH_GITHUB_TOKEN');
			if (typeof hit?.value === 'string' && hit.value.trim().length > 0) return hit.value.trim();
		} catch {
			/* fall through to the environment */
		}
	}

	const fromEnv = process.env.DSH_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
	return typeof fromEnv === 'string' && fromEnv.trim().length > 0 ? fromEnv.trim() : undefined;
}

/**
 * The message shown when no token is available, naming every way to provide one.
 *
 * A function rather than a constant because the collaboration tools need the same
 * three routes with a different opening sentence, and duplicating the list would
 * let the two copies drift.
 *
 * @param action - what could not happen, e.g. `'published'` or `'synced'`.
 * @returns the message.
 */
export function noTokenMessage(action = 'published') {
	return [
		`No GitHub token is configured, so nothing can be ${action}.`,
		'',
		'Provide one by any of these routes:',
		'  1. The plugin config field "token" (profile cordis.patch.yml).',
		'  2. The DSH credential store under the reference DSH_GITHUB_TOKEN.',
		'  3. The environment variable DSH_GITHUB_TOKEN (or GITHUB_TOKEN).',
		'',
		'The token needs the "repo" scope to create a repository and upload to it.'
	].join('\n');
}

/** The publish tool's message, kept for the tests and callers that import it. */
export const NO_TOKEN_MESSAGE = noTokenMessage();

/**
 * Read a plugin's manifest, or null when it cannot be read.
 *
 * Used to fill in the repository name and description, so the common publish call
 * needs only a directory.
 *
 * @param directory - the plugin package root.
 * @returns the parsed manifest, or null.
 */
export async function readManifest(directory) {
	try {
		const { readFile } = await import('node:fs/promises');
		const { join } = await import('node:path');
		return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
	} catch {
		return null;
	}
}

/**
 * Build the `publish_plugin` definition.
 *
 * @param ctx - plugin context.
 * @param config - the validated plugin config.
 * @returns a registry-ready ToolDefinition.
 */
export function publishTool(ctx, config) {
	return {
		name: PUBLISH_TOOL,
		description:
			'Publish a DSH plugin directory to GitHub, so it can be installed on another machine with ' +
			'`dsh plugin add github:<owner>/<repo>`. Validates the manifest first, then creates the repository ' +
			'if needed, uploads the working tree as one commit, and sets the dsh-plugin topic. ' +
			'This creates a PUBLIC repository under the user\'s account unless private is true.',
		parameters: PUBLISH_PARAMETERS,
		output: { schema: RESULT_SCHEMA, render: (_args, value) => renderResult(value) },
		async execute(args) {
			const parsed = readArgs(args, [
				'directory',
				'owner',
				'repo',
				'description',
				'private',
				'replace_existing',
				'submit',
				'category'
			]);
			if (parsed.error !== undefined) return { ok: false, steps: [], error: parsed.error };

			const token = await findToken(ctx, config);
			if (token === undefined) return { ok: false, steps: [], error: NO_TOKEN_MESSAGE };

			const subprocess = ctx.get('subprocess');
			if (subprocess === undefined) {
				return { ok: false, steps: [], error: 'The host subprocess service is unavailable, so git cannot run.' };
			}

			// --- resolve what the caller may leave out --------------------------
			//
			// An agent publishing its own work should not have to state the account, the
			// repository name or a description: all three are discoverable. Resolving
			// them here keeps the tool call to a single argument in the common case.
			const manifest = await readManifest(parsed.value.directory);

			// The owner comes from the token. This also proves the token works before
			// anything is created, which is the cheapest possible failure.
			let owner = parsed.value.owner ?? (typeof config?.owner === 'string' ? config.owner.trim() : '');
			if (owner.length === 0) {
				try {
					const { verifyToken } = await import('./github.js');
					owner = (await verifyToken(token)).login;
				} catch (error) {
					return { ok: false, steps: [], error: `The GitHub token was rejected: ${String(error.message)}` };
				}
			}

			const repo = parsed.value.repo ?? manifest?.name;
			const description = parsed.value.description ?? manifest?.description;

			// `submit` defaults to false: this plugin exists for personal use, and the
			// marketplace submission is a separate decision with its own requirements.
			// `replace_existing` defaults to false too: overwriting a branch is the one
			// destructive thing this tool can do, so it is opt-in.
			const result = await publish({
				subprocess,
				directory: parsed.value.directory,
				token,
				owner,
				repo,
				description,
				category: parsed.value.category ?? 'dev',
				private: parsed.value.private === true,
				replaceExisting: parsed.value.replace_existing === true,
				submit: parsed.value.submit === true
			});
			return result;
		}
	};
}

/**
 * Build the `check_plugin` definition.
 *
 * Read-only: it changes nothing and contacts nothing. Having it as its own tool
 * means the agent can inspect a plugin before deciding whether to publish it.
 *
 * @param ctx - plugin context.
 * @returns a registry-ready ToolDefinition.
 */
export function checkTool(ctx) {
	return {
		name: CHECK_TOOL,
		description:
			'Validate a DSH plugin directory against the requirements for publishing and installing: the bundle ' +
			'manifest, the three identifiers that must agree (package name, patch insert id, client bundle id), ' +
			'credential files that must never be published, and the metadata. Changes nothing.',
		parameters: CHECK_PARAMETERS,
		output: { schema: RESULT_SCHEMA, render: (_args, value) => renderResult(value) },
		async execute(args) {
			const parsed = readArgs(args, ['directory', 'owner', 'repo']);
			if (parsed.error !== undefined) return { ok: false, steps: [], error: parsed.error };

			const subprocess = ctx.get('subprocess');
			if (subprocess === undefined) {
				return { ok: false, steps: [], error: 'The host subprocess service is unavailable.' };
			}

			const report = await inspect(subprocess, parsed.value.directory, {
				owner: parsed.value.owner ?? '',
				repo: parsed.value.repo ?? '',
				// Personal use: the listing rules are not applied, so a category and a
				// marketing-free English sentence are not required.
				submit: false
			});
			return { ok: report.ok, steps: [], findings: report.findings, package: report.package, git: report.git };
		}
	};
}
