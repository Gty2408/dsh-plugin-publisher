/**
 * Uploading a tree and opening a pull request over the GitHub REST API.
 *
 * ## Why this module exists
 *
 * `git push` needs `github.com:443`. On a network that blocks that host — while
 * leaving `api.github.com` reachable — the push fails with a connectivity error
 * and no amount of retrying helps. Measured on the machine this was built for:
 *
 *     api.github.com:443   reachable in ~185 ms
 *     github.com:443       TCP connect fails after ~22 s
 *
 * The REST API is a different host, so it still works. This module is the fallback
 * transport: it writes the same content the push would have written, using the
 * git-data endpoints (blobs → tree → commit → ref) rather than the pack protocol.
 *
 * ## Two shapes of upload, and why they differ
 *
 * - **Publishing a plugin** replaces the repository's content with the directory.
 *   No `base_tree`, so a file deleted locally is deleted remotely — which is what
 *   "publish this directory" means.
 * - **Submitting to the marketplace list** is ADDITIVE. `base_tree` is the fork's
 *   own tree, so the commit contains the whole list plus one file. Without
 *   `base_tree` the commit would contain only the submission and would delete the
 *   entire list — a mistake worth naming, because it is silent and destructive.
 *
 * @module dsh-plugin-publisher/transfer
 */

import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** GitHub's REST host. Deliberately separate from the git host. */
const API = 'https://api.github.com';

/** One file per blob, so a runaway directory cannot exhaust memory. */
const MAX_FILE_BYTES = 40 * 1024 * 1024;

/** Paths never uploaded, whatever the ignore rules say. */
const NEVER_UPLOAD = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db']);

/**
 * Whether a git failure was caused by not reaching the server.
 *
 * This is the signal that the API transport should take over. It is deliberately
 * narrow: an authentication failure must NOT trigger the fallback, because the
 * API would fail the same way and the user would get a confusing second error
 * instead of the real one.
 *
 * @param error - the thrown error, or its message.
 * @returns true when the failure looks like a network problem.
 */
export function isConnectivityError(error) {
	const text = String(error?.stderr ?? error?.message ?? error).toLowerCase();
	return [
		'could not connect to server',
		'failed to connect',
		'could not resolve host',
		'connection reset',
		'connection timed out',
		'operation timed out',
		'empty reply from server',
		'rpc failed',
		'network is unreachable',
		'tls handshake timeout',
		'early eof'
	].some((needle) => text.includes(needle));
}

/**
 * Call the GitHub API.
 *
 * @param path - API path beginning with `/`.
 * @param options - `token`, `method`, `body`.
 * @returns the parsed JSON body, or null for an empty response.
 * @throws an Error carrying `status` and GitHub's own message.
 */
async function call(path, options) {
	const response = await fetch(`${API}${path}`, {
		method: options.method ?? 'GET',
		headers: {
			Accept: 'application/vnd.github+json',
			Authorization: `Bearer ${options.token}`,
			'User-Agent': 'dsh-plugin-publisher',
			'X-GitHub-Api-Version': '2022-11-28',
			...(options.body === undefined ? {} : { 'Content-Type': 'application/json' })
		},
		...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
	});

	let payload = null;
	try {
		payload = await response.json();
	} catch {
		/* an empty body is normal for some endpoints */
	}

	if (!response.ok) {
		const detail = Array.isArray(payload?.errors)
			? ` (${payload.errors.map((item) => item.message ?? item.field ?? String(item)).join('; ')})`
			: '';
		const error = new Error(`${payload?.message ?? response.statusText}${detail}`);
		error.status = response.status;
		throw error;
	}
	return payload;
}

/**
 * List the files a publish should upload.
 *
 * `git ls-files` is used rather than walking the directory, because it is the only
 * enumeration that honours `.gitignore` exactly — including nested ignore files,
 * negations and the global excludes file. Walking by hand would upload build
 * output and editor state that the author deliberately excluded, and would miss
 * nothing that git would have committed.
 *
 * `--cached --others --exclude-standard` means: tracked files, plus untracked
 * files that are not ignored. That is precisely the set `git add -A` would stage.
 *
 * @param subprocess - the Host subprocess service.
 * @param directory - the repository root.
 * @returns absolute/relative path pairs, using forward slashes.
 */
export async function listFilesToUpload(subprocess, directory) {
	const { runGit } = await import('./git.js');
	const result = await runGit(
		subprocess,
		['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
		{ cwd: directory }
	);
	if (result.exitCode !== 0) {
		throw new Error(`git ls-files failed: ${result.stderr.trim() || `exit ${String(result.exitCode)}`}`);
	}

	const paths = result.stdout
		.split('\u0000')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);

	const files = [];
	for (const path of paths) {
		const normalised = path.split(sep).join('/');
		// git already honours .gitignore; this only catches a directory that is not
		// ignored but must never be uploaded.
		if (NEVER_UPLOAD.has(normalised.split('/')[0])) continue;
		files.push({ path: normalised, full: join(directory, path) });
	}
	return files;
}

/**
 * Whether a branch already has commits this upload would discard.
 *
 * ## Why this exists
 *
 * The upload builds a commit with no `base_tree`, so it REPLACES the repository's
 * content. That is correct for "publish this directory", but it also discards
 * whatever the branch already had — including work pushed from another machine.
 * Overwriting silently is the one destructive thing this plugin can do, so it asks
 * first.
 *
 * The check reads the branch and compares its commit count. A branch with only the
 * repository's own initial commit is not "existing work": that commit comes from
 * `auto_init` and contains nothing but a generated README, so replacing it loses
 * nothing a user would miss.
 *
 * @param token - a GitHub personal access token.
 * @param owner - the repository owner.
 * @param repo - the repository name.
 * @param branch - the branch to inspect.
 * @returns `{ exists, commits, onlyInitial, head }`.
 */
export async function inspectBranch(token, owner, repo, branch) {
	try {
		const ref = await call(`/repos/${owner}/${repo}/git/ref/heads/${branch}`, { token });
		const head = ref.object.sha;
		// `per_page=2` is enough: only "is there more than the initial commit" matters.
		const commits = await call(`/repos/${owner}/${repo}/commits?sha=${head}&per_page=2`, { token });
		const count = Array.isArray(commits) ? commits.length : 0;
		return { exists: true, commits: count, onlyInitial: count <= 1, head };
	} catch (error) {
		// 404 or 409 both mean "no such branch yet" — a brand-new repository.
		if (error.status === 404 || error.status === 409) {
			return { exists: false, commits: 0, onlyInitial: true, head: undefined };
		}
		throw error;
	}
}

/**
 * Upload a directory as the repository's content, in one commit.
 *
 * @param options - `token`, `owner`, `repo`, `branch`, `subprocess`, `directory`,
 *   `message`, `replaceExisting` (required to overwrite a branch that already has
 *   real commits).
 * @returns `{ commit, fileCount }`.
 * @throws when the branch has commits and `replaceExisting` is not set.
 */
export async function uploadTree(options) {
	const { token, owner, repo, branch, subprocess, directory, message, replaceExisting = false } = options;

	const files = await listFilesToUpload(subprocess, directory);
	if (files.length === 0) {
		throw new Error('There is nothing to upload: git ls-files reported no files.');
	}

	// --- refuse to discard existing work unless told to ----------------------
	//
	// This runs BEFORE any blob is uploaded, so a refusal costs nothing and leaves
	// the repository untouched.
	const state = await inspectBranch(token, owner, repo, branch);
	if (state.exists && !state.onlyInitial && !replaceExisting) {
		const error = new Error(
			`The branch "${branch}" already has commits, and uploading would replace them.`
		);
		error.status = 409;
		error.hint =
			'Nothing was changed. Pass replace_existing to overwrite it, or use a different repository name to keep both.';
		error.existing = { branch, head: state.head };
		throw error;
	}

	// --- one blob per file ---------------------------------------------------
	const entries = [];
	for (const file of files) {
		const content = await readFile(file.full);
		if (content.byteLength > MAX_FILE_BYTES) {
			throw new Error(
				`${file.path} is ${(content.byteLength / 1024 / 1024).toFixed(1)} MB, over the ${String(MAX_FILE_BYTES / 1024 / 1024)} MB API limit. ` +
					'Use a release asset for files this large.'
			);
		}
		const blob = await call(`/repos/${owner}/${repo}/git/blobs`, {
			token,
			method: 'POST',
			body: { content: content.toString('base64'), encoding: 'base64' }
		});
		entries.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
	}

	// --- the tree ------------------------------------------------------------
	// No `base_tree`: this commit IS the repository content, so anything removed
	// locally is removed remotely.
	const tree = await call(`/repos/${owner}/${repo}/git/trees`, {
		token,
		method: 'POST',
		body: { tree: entries }
	});

	// --- the commit ----------------------------------------------------------
	// A parent keeps the history linear. A repository that only has the API's
	// `auto_init` commit gets its first real commit here.
	let parents = [];
	try {
		const ref = await call(`/repos/${owner}/${repo}/git/ref/heads/${branch}`, { token });
		parents = [ref.object.sha];
	} catch (error) {
		if (error.status !== 404 && error.status !== 409) throw error;
	}

	const commit = await call(`/repos/${owner}/${repo}/git/commits`, {
		token,
		method: 'POST',
		body: {
			message,
			tree: tree.sha,
			...(parents.length === 0 ? {} : { parents })
		}
	});

	// --- point the branch at it ---------------------------------------------
	if (parents.length === 0) {
		await call(`/repos/${owner}/${repo}/git/refs`, {
			token,
			method: 'POST',
			body: { ref: `refs/heads/${branch}`, sha: commit.sha }
		});
	} else {
		await call(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
			token,
			method: 'PATCH',
			body: { sha: commit.sha, force: true }
		});
	}

	return { commit: commit.sha, fileCount: entries.length };
}

/**
 * Append the directory's files onto the head of an existing branch.
 *
 * This is the third upload shape (see the module comment). It differs from
 * {@link uploadTree} in exactly the two ways collaboration needs:
 *
 *   - `base_tree` IS set, to the head commit's tree. The commit therefore adds and
 *     overwrites the files this machine touched and leaves every other file — in
 *     particular every other machine's work — exactly as it was. Without
 *     `base_tree`, syncing one machine would delete every file that machine did not
 *     happen to have, which is the destructive bug this function exists to avoid.
 *   - the parent is the branch's current head, read here rather than assumed. The
 *     commit lands on top of whatever is already there, so two machines appending
 *     in sequence build a linear history instead of racing.
 *
 * The branch must already exist. A machine branch is created by `join_project` and
 * by the SSH push, so a missing branch here means the caller skipped a step, and
 * saying so is more useful than silently creating a branch with no history.
 *
 * @param options - `token`, `owner`, `repo`, `branch`, `subprocess`, `directory`,
 *   `message`.
 * @returns `{ commit, fileCount }`.
 * @throws when the branch does not exist, or the directory has no files.
 */
export async function appendTree(options) {
	const { token, owner, repo, branch, subprocess, directory, message } = options;

	const files = await listFilesToUpload(subprocess, directory);
	if (files.length === 0) {
		throw new Error('There is nothing to upload: git ls-files reported no files.');
	}

	// --- the branch's head, and the tree the commit sits on top of -----------
	let head;
	try {
		head = await call(`/repos/${owner}/${repo}/git/ref/heads/${branch}`, { token });
	} catch (error) {
		if (error.status === 404 || error.status === 409) {
			const missing = new Error(`The branch "${branch}" does not exist on ${owner}/${repo}.`);
			missing.status = 404;
			missing.hint = 'Join the project first, so this machine has a branch of its own to append to.';
			throw missing;
		}
		throw error;
	}
	const headCommit = await call(`/repos/${owner}/${repo}/git/commits/${head.object.sha}`, { token });

	// --- one blob per file ---------------------------------------------------
	const entries = [];
	for (const file of files) {
		const content = await readFile(file.full);
		if (content.byteLength > MAX_FILE_BYTES) {
			throw new Error(
				`${file.path} is ${(content.byteLength / 1024 / 1024).toFixed(1)} MB, over the ${String(MAX_FILE_BYTES / 1024 / 1024)} MB API limit. ` +
					'Use a release asset for files this large.'
			);
		}
		const blob = await call(`/repos/${owner}/${repo}/git/blobs`, {
			token,
			method: 'POST',
			body: { content: content.toString('base64'), encoding: 'base64' }
		});
		entries.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
	}

	// --- the tree, on top of the existing one --------------------------------
	const tree = await call(`/repos/${owner}/${repo}/git/trees`, {
		token,
		method: 'POST',
		body: { base_tree: headCommit.tree.sha, tree: entries }
	});

	const commit = await call(`/repos/${owner}/${repo}/git/commits`, {
		token,
		method: 'POST',
		body: { message, tree: tree.sha, parents: [head.object.sha] }
	});

	// --- fast-forward the branch, never force --------------------------------
	// The parent is the head that was just read, so this is a fast-forward and
	// `force` is unnecessary. Leaving it off means a concurrent push from another
	// machine is rejected rather than overwritten.
	await call(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
		token,
		method: 'PATCH',
		body: { sha: commit.sha }
	});

	return { commit: commit.sha, fileCount: entries.length };
}

/**
 * A branch name unique to one submission.
 *
 * ## Why this is not a constant
 *
 * It used to be the fixed string `add-plugin`, which is a destructive bug: a fork
 * has ONE such branch, so publishing a second plugin overwrote the first plugin's
 * submission commit. The observable damage was that the first pull request kept
 * its title while its diff silently became the second plugin — and the first
 * plugin's submission file was deleted from the branch, so that pull request could
 * never be merged correctly.
 *
 * Deriving the branch from the repository name gives each plugin its own branch,
 * so submissions cannot collide, and re-running the SAME plugin still finds its
 * own branch (which is what makes the "already open" check work).
 *
 * @param repo - the plugin's repository name.
 * @returns a branch name such as `add-dsh-word-translate`.
 */
function submissionBranch(repo) {
	// Git refs allow a lot, but a conservative subset avoids surprising the
	// marketplace's own tooling.
	const safe = String(repo)
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/gu, '-')
		.replace(/^[-.]+|[-.]+$/gu, '')
		.slice(0, 60);
	return `add-${safe.length > 0 ? safe : 'plugin'}`;
}

/**
 * Fork the marketplace list, add one submission file, and open a pull request.
 *
 * Everything goes through the API because a fork cannot be cloned on a network
 * that blocks `github.com`.
 *
 * @param options - `token`, `login`, `submission` (`fileName`, `url`, `name`,
 *   `category`, `description`), `content` (the rendered YAML), `marketOwner`,
 *   `marketRepo`, `branch` (defaults to a per-plugin branch).
 * @returns `{ number, htmlUrl, existing }`.
 */
export async function openSubmissionPr(options) {
	const {
		token,
		login,
		submission,
		content,
		marketOwner,
		marketRepo,
		branch = submissionBranch(submission.name.split('/').pop() ?? submission.name)
	} = options;

	// --- fork ----------------------------------------------------------------
	try {
		await call(`/repos/${marketOwner}/${marketRepo}/forks`, { token, method: 'POST', body: {} });
	} catch (error) {
		// 422 means the fork already exists, which is the normal re-run case.
		if (error.status !== 422) throw error;
	}

	// --- wait for it ---------------------------------------------------------
	// Forking is queued server-side; the API answers before the repository is
	// readable, so an immediate read is a 404 that looks like a permissions bug.
	let fork = null;
	for (let attempt = 0; attempt < 30; attempt += 1) {
		try {
			fork = await call(`/repos/${login}/${marketRepo}`, { token });
			break;
		} catch (error) {
			if (error.status !== 404) throw error;
			await new Promise((resolve) => setTimeout(resolve, 2_000));
		}
	}
	if (fork === null) throw new Error('The fork did not appear within 60s. Try again in a moment.');

	const base = fork.default_branch;

	// --- the base tree -------------------------------------------------------
	const baseRef = await call(`/repos/${login}/${marketRepo}/git/ref/heads/${base}`, { token });
	const baseCommit = await call(`/repos/${login}/${marketRepo}/git/commits/${baseRef.object.sha}`, { token });

	// --- the submission blob -------------------------------------------------
	const blob = await call(`/repos/${login}/${marketRepo}/git/blobs`, {
		token,
		method: 'POST',
		body: { content: Buffer.from(content, 'utf8').toString('base64'), encoding: 'base64' }
	});

	// --- a tree with ONE change on top of the base ---------------------------
	// `base_tree` is what keeps the rest of the list intact.
	const tree = await call(`/repos/${login}/${marketRepo}/git/trees`, {
		token,
		method: 'POST',
		body: {
			base_tree: baseCommit.tree.sha,
			tree: [{ path: `data/plugins/${submission.fileName}`, mode: '100644', type: 'blob', sha: blob.sha }]
		}
	});

	const commit = await call(`/repos/${login}/${marketRepo}/git/commits`, {
		token,
		method: 'POST',
		body: {
			message: `Add ${submission.name}`,
			tree: tree.sha,
			parents: [baseRef.object.sha]
		}
	});

	// --- the branch ----------------------------------------------------------
	try {
		await call(`/repos/${login}/${marketRepo}/git/refs`, {
			token,
			method: 'POST',
			body: { ref: `refs/heads/${branch}`, sha: commit.sha }
		});
	} catch (error) {
		if (error.status !== 422) throw error;
		await call(`/repos/${login}/${marketRepo}/git/refs/heads/${branch}`, {
			token,
			method: 'PATCH',
			body: { sha: commit.sha, force: true }
		});
	}

	// --- the pull request ----------------------------------------------------
	// Re-running must not open a second identical pull request.
	const existing = await call(
		`/repos/${marketOwner}/${marketRepo}/pulls?state=open&head=${encodeURIComponent(`${login}:${branch}`)}`,
		{ token }
	);
	if (Array.isArray(existing) && existing.length > 0) {
		return { number: existing[0].number, htmlUrl: existing[0].html_url, existing: true };
	}

	try {
		const pr = await call(`/repos/${marketOwner}/${marketRepo}/pulls`, {
			token,
			method: 'POST',
			body: {
				title: `Add ${submission.name}`,
				head: `${login}:${branch}`,
				base,
				body: [
					`Adds [${submission.name}](${submission.url}) to the list.`,
					'',
					`- Category: \`${submission.category}\``,
					`- Description: ${submission.description.en}`,
					'',
					'---',
					'',
					'Submitted with [dsh-plugin-publisher](https://github.com/deepseek-ai/deepseek-harness).',
					''
				].join('\n')
			}
		});
		return { number: pr.number, htmlUrl: pr.html_url, existing: false };
	} catch (error) {
		if (error.status === 422) {
			const conflict = new Error('GitHub refused the pull request.');
			conflict.hint =
				'This usually means the submission is already in the list, or a pull request for it is already open.';
			throw conflict;
		}
		throw error;
	}
}

/**
 * Whether the git host is reachable at all.
 *
 * Used to decide the transport up front instead of paying for a failed push first.
 * The probe is a plain TCP-level request to the API host, which is the same host
 * the fallback uses — so a positive result means the fallback will work.
 *
 * @param token - a GitHub personal access token.
 * @returns true when `api.github.com` answers.
 */
export async function apiReachable(token) {
	try {
		const response = await fetch(`${API}/rate_limit`, {
			headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'dsh-plugin-publisher' }
		});
		return response.ok;
	} catch {
		return false;
	}
}

/** Exposed for tests: the never-upload set. */
export const neverUpload = NEVER_UPLOAD;

/** Exposed for tests: compute a path relative to a directory, forward-slashed. */
export function relativePath(directory, full) {
	return relative(directory, full).split(sep).join('/');
}
