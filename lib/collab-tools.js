/**
 * The five collaboration tools.
 *
 * ## Why there are five and not one
 *
 * Each of these is a distinct decision with a different blast radius, and merging
 * them would mean a single tool whose effect depends on which arguments happen to
 * be set — the worst possible shape for something that writes to a shared
 * repository. Naming them separately also means the model can be told, in the
 * description, exactly when each one is the right one:
 *
 *   - `join_project`   — this machine has never worked on this project
 *   - `share_project`  — this machine's directory IS the project (creates `main`)
 *   - `sync_project`   — move this machine's work up and everybody else's down
 *   - `merge_project`  — combine other machines' branches
 *   - `project_status` — report, change nothing
 *
 * ## What every one of them has in common
 *
 * The directory is the only required argument, exactly as with `publish_plugin`:
 * everything else (which repository, which account, which branch) is readable from
 * the token and the directory's own `origin` remote. An agent asked to "sync my
 * work" should not have to look up an owner name first.
 *
 * @module dsh-plugin-publisher/collab-tools
 */

import {
	arg,
	readArgs,
	readManifest,
	renderResult,
	RESULT_SCHEMA,
	DIRECTORY_ARG,
	noTokenMessage,
	findToken
} from './tool.js';
import { joinProject, shareProject, syncProject, mergeProject, projectStatus } from './collab-sync.js';

/** Tool names. Exported so tests, docs and the README cannot drift apart. */
export const JOIN_TOOL = 'join_project';
export const SHARE_TOOL = 'share_project';
export const SYNC_TOOL = 'sync_project';
export const MERGE_TOOL = 'merge_project';
export const STATUS_TOOL = 'project_status';

/** Every collaboration tool name, in the order the docs present them. */
export const COLLAB_TOOLS = [JOIN_TOOL, SHARE_TOOL, SYNC_TOOL, MERGE_TOOL, STATUS_TOOL];

/** The `owner`/`repo` pair, worded once because five tools accept it. */
const OWNER_ARG = arg(
	'string',
	'GitHub account that owns the repository. Usually omitted: it is read from the directory\'s "origin" remote.'
);
const REPO_ARG = arg('string', 'Repository name. Usually omitted, for the same reason as owner.');
const MACHINE_ARG = arg(
	'string',
	'Name for this machine, used to build its branch. Defaults to the machine\'s hostname. Set it once if the hostname is not a name you want to see in a branch.'
);

/**
 * What every collaboration flow needs: a directory, and optionally the remote.
 *
 * `machine` is declared on all five even though it is only interesting on some,
 * because every flow resolves it and the registry shows the model only what the
 * schema declares — an accepted-but-undeclared argument is one the model cannot
 * know to pass.
 */
function parameters(extra = {}, required = ['directory']) {
	return {
		type: 'object',
		properties: { directory: DIRECTORY_ARG, owner: OWNER_ARG, repo: REPO_ARG, machine: MACHINE_ARG, ...extra },
		required
	};
}

/**
 * Assemble the shared prologue of a collaboration tool call.
 *
 * The token and the subprocess service are needed by all five, and the failure
 * text for each is identical, so it is resolved in one place.
 *
 * @param ctx - plugin context.
 * @param config - the validated plugin config.
 * @param args - the raw tool arguments.
 * @param allowed - the accepted keys.
 * @param options - the key typing overrides.
 * @param action - the verb for the no-token message.
 * @returns `{ value, token, subprocess }` or `{ error }`.
 */
async function prologue(ctx, config, args, allowed, options, action) {
	const parsed = readArgs(args, allowed, options);
	if (parsed.error !== undefined) return { error: parsed.error };

	const token = await findToken(ctx, config);
	if (token === undefined) return { error: noTokenMessage(action) };

	const subprocess = ctx.get('subprocess');
	if (subprocess === undefined) {
		return { error: 'The host subprocess service is unavailable, so git cannot run.' };
	}
	return { value: parsed.value, token, subprocess };
}

/**
 * Fill in `owner`/`repo` from the plugin config or the manifest.
 *
 * The flows can also read them from `origin`, but passing them when they are
 * already known makes the very first call on a fresh directory work — the case
 * where there is no remote yet and nothing to read.
 */
async function withRepository(value, config) {
	const out = { ...value };
	if (out.owner === undefined && typeof config?.owner === 'string' && config.owner.trim().length > 0) {
		out.owner = config.owner.trim();
	}
	if (out.repo === undefined && out.owner !== undefined) {
		const manifest = await readManifest(out.directory);
		if (typeof manifest?.name === 'string' && manifest.name.trim().length > 0) out.repo = manifest.name.trim();
	}
	// Half a pair is worse than none: `owner` without `repo` would make the flows
	// ignore the remote and fail on a repository that is right there.
	if (out.owner === undefined || out.repo === undefined) {
		delete out.owner;
		delete out.repo;
	}
	return out;
}

/**
 * Build the `join_project` definition.
 *
 * @param ctx - plugin context.
 * @param config - the validated plugin config.
 * @returns a registry-ready ToolDefinition.
 */
export function joinTool(ctx, config) {
	return {
		name: JOIN_TOOL,
		description:
			'Start working on an existing shared project from this machine. Creates this machine\'s own branch, ' +
			'generates an SSH key for this machine and installs it on the repository, then merges the project\'s main ' +
			'branch into the local files and pushes. Run this once per machine per project, before sync_project. ' +
			'If the local files and main conflict, it stops and lists the files; edit them to remove the ' +
			'<<<<<<< / ======= / >>>>>>> markers and run it again to finish.',
		parameters: parameters(),
		output: { schema: RESULT_SCHEMA, render: (_args, value) => renderResult(value) },
		async execute(args) {
			const ready = await prologue(ctx, config, args, ['directory', 'owner', 'repo', 'machine'], { strings: ['owner', 'repo', 'machine'], booleans: [] }, 'joined');
			if (ready.error !== undefined) return { ok: false, steps: [], error: ready.error };

			const value = await withRepository(ready.value, config);
			return joinProject({
				subprocess: ready.subprocess,
				directory: value.directory,
				token: ready.token,
				owner: value.owner,
				repo: value.repo,
				machine: value.machine
			});
		}
	};
}

/**
 * Build the `share_project` definition.
 *
 * @param ctx - plugin context.
 * @param config - the validated plugin config.
 * @returns a registry-ready ToolDefinition.
 */
export function shareTool(ctx, config) {
	return {
		name: SHARE_TOOL,
		description:
			'Turn this directory into a shared project that other machines can join: uploads it to the repository\'s ' +
			'main branch, creates this machine\'s own branch from it, and optionally invites a second person as a ' +
			'collaborator. Refuses to run when main already has commits unless replace_existing is true, because that ' +
			'would discard other machines\' work. Creates a PUBLIC repository unless private is true.',
		parameters: parameters({
			description: arg('string', 'One-line repository description. Defaults to the package.json description.'),
			private: arg('boolean', 'Create the repository as private instead of public. Defaults to false.'),
			replace_existing: arg(
				'boolean',
				'Overwrite a main branch that already has commits. Defaults to false: without it nothing is changed.'
			),
			collaborator: arg(
				'string',
				'GitHub username of a second person to invite to the repository. They must accept the invitation before their machine can push.'
			)
		}),
		output: { schema: RESULT_SCHEMA, render: (_args, value) => renderResult(value) },
		async execute(args) {
			const ready = await prologue(
				ctx,
				config,
				args,
				['directory', 'owner', 'repo', 'description', 'private', 'replace_existing', 'collaborator', 'machine'],
				{ strings: ['owner', 'repo', 'description', 'collaborator', 'machine'], booleans: ['private', 'replace_existing'] },
				'shared'
			);
			if (ready.error !== undefined) return { ok: false, steps: [], error: ready.error };

			let value = await withRepository(ready.value, config);
			if (value.description === undefined) {
				const manifest = await readManifest(value.directory);
				if (typeof manifest?.description === 'string' && manifest.description.trim().length > 0) {
					value = { ...value, description: manifest.description.trim() };
				}
			}

			return shareProject({
				subprocess: ready.subprocess,
				directory: value.directory,
				token: ready.token,
				owner: value.owner,
				repo: value.repo,
				description: value.description,
				private: value.private === true,
				replaceExisting: value.replace_existing === true,
				collaborator: value.collaborator,
				machine: value.machine
			});
		}
	};
}

/**
 * Build the `sync_project` definition.
 *
 * @param ctx - plugin context.
 * @param config - the validated plugin config.
 * @returns a registry-ready ToolDefinition.
 */
export function syncTool(ctx, config) {
	return {
		name: SYNC_TOOL,
		description:
			'Send this machine\'s work to the repository and bring the other machines\' work back, in one step. ' +
			'Commits the working tree onto this machine\'s own branch, merges the project\'s main branch into it, ' +
			'then pushes. This is the everyday command. If main and this machine\'s branch conflict, it stops and ' +
			'lists the files; edit them to remove the <<<<<<< / ======= / >>>>>>> markers and run it again.',
		parameters: parameters({
			message: arg('string', 'Commit message for the local changes. A generic one is used when omitted.'),
			push: arg('boolean', 'Push this machine\'s branch afterwards. Defaults to true; set false to merge only.')
		}),
		output: { schema: RESULT_SCHEMA, render: (_args, value) => renderResult(value) },
		async execute(args) {
			const ready = await prologue(
				ctx,
				config,
				args,
				['directory', 'owner', 'repo', 'machine', 'message', 'push'],
				{ strings: ['owner', 'repo', 'machine', 'message'], booleans: ['push'] },
				'synced'
			);
			if (ready.error !== undefined) return { ok: false, steps: [], error: ready.error };

			const value = await withRepository(ready.value, config);
			return syncProject({
				subprocess: ready.subprocess,
				directory: value.directory,
				token: ready.token,
				owner: value.owner,
				repo: value.repo,
				machine: value.machine,
				message: value.message,
				push: value.push !== false
			});
		}
	};
}

/**
 * Build the `merge_project` definition.
 *
 * @param ctx - plugin context.
 * @param config - the validated plugin config.
 * @returns a registry-ready ToolDefinition.
 */
export function mergeTool(ctx, config) {
	return {
		name: MERGE_TOOL,
		description:
			'Combine other machines\' branches into one. By default they are merged into this machine\'s own branch, ' +
			'so the combined result can be tested without changing anything shared. With into "main" they are merged ' +
			'into the project\'s main branch, which is the act of agreeing on a result. A conflict stops the run and ' +
			'lists the files; edit them to remove the <<<<<<< / ======= / >>>>>>> markers and run it again.',
		parameters: parameters({
			branches: arg('array', 'Machine branches to merge, e.g. ["machine/alpha"]. Defaults to every machine branch on the repository.', {
				items: { type: 'string' }
			}),
			into: arg('string', 'Where to merge them: "machine" (this machine\'s own branch, the default) or "main".', {
				enum: ['machine', 'main']
			}),
			push: arg('boolean', 'Publish the merged branch afterwards. Defaults to false, so the result can be inspected first.')
		}),
		output: { schema: RESULT_SCHEMA, render: (_args, value) => renderResult(value) },
		async execute(args) {
			const ready = await prologue(
				ctx,
				config,
				args,
				['directory', 'owner', 'repo', 'machine', 'branches', 'into', 'push'],
				{ strings: ['owner', 'repo', 'machine', 'into'], booleans: ['push'], arrays: ['branches'] },
				'merged'
			);
			if (ready.error !== undefined) return { ok: false, steps: [], error: ready.error };

			if (ready.value.into !== undefined && ready.value.into !== 'machine' && ready.value.into !== 'main') {
				return { ok: false, steps: [], error: '"into" must be "machine" or "main".' };
			}

			const value = await withRepository(ready.value, config);
			return mergeProject({
				subprocess: ready.subprocess,
				directory: value.directory,
				token: ready.token,
				owner: value.owner,
				repo: value.repo,
				machine: value.machine,
				branches: value.branches,
				into: value.into ?? 'machine',
				push: value.push === true
			});
		}
	};
}

/**
 * Build the `project_status` definition.
 *
 * Read-only on purpose: after a confusing merge the first question is what state
 * things are actually in, and answering it must not be able to make them worse.
 *
 * @param ctx - plugin context.
 * @param config - the validated plugin config.
 * @returns a registry-ready ToolDefinition.
 */
export function statusTool(ctx, config) {
	return {
		name: STATUS_TOOL,
		description:
			'Report where this machine stands in a shared project: the repository, this machine\'s branch, whether ' +
			'the working tree is dirty, whether a merge is half-finished, how this branch compares with main, and ' +
			'which other machine branches exist. Changes nothing, contacts nothing but GitHub.',
		parameters: parameters(),
		output: { schema: RESULT_SCHEMA, render: (_args, value) => renderResult(value) },
		async execute(args) {
			const ready = await prologue(ctx, config, args, ['directory', 'owner', 'repo', 'machine'], { strings: ['owner', 'repo', 'machine'], booleans: [] }, 'inspected');
			if (ready.error !== undefined) return { ok: false, steps: [], error: ready.error };

			const value = await withRepository(ready.value, config);
			return projectStatus({
				subprocess: ready.subprocess,
				directory: value.directory,
				token: ready.token,
				owner: value.owner,
				repo: value.repo,
				machine: value.machine
			});
		}
	};
}

/**
 * Every collaboration tool, in registration order.
 *
 * @param ctx - plugin context.
 * @param config - the validated plugin config.
 * @returns an array of registry-ready ToolDefinitions.
 */
export function collabTools(ctx, config) {
	return [joinTool(ctx, config), shareTool(ctx, config), syncTool(ctx, config), mergeTool(ctx, config), statusTool(ctx, config)];
}
