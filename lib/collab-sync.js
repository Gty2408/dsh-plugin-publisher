/**
 * The five collaboration flows: join, share, sync, merge, status.
 *
 * ## The shape of the problem
 *
 * Publishing is one-way and destructive-by-design: a directory becomes a
 * repository. Collaboration cannot be, because two machines writing to one
 * repository must not destroy each other's work. Every flow here is therefore
 * built on one rule:
 *
 *     A machine only ever writes to a branch it owns.
 *
 * `main` is the shared, agreed-upon result. Each machine owns `machine/<name>`
 * (see {@link module:dsh-plugin-publisher/collab}). Work goes:
 *
 *     local files -> machine/<name> -> (merge) -> main
 *
 * Nothing pushes straight to `main` except {@link shareProject}, which is the
 * "this directory IS the project" act — and that one keeps the publisher's
 * overwrite guard, so it can never silently discard a branch that already holds
 * real commits.
 *
 * ## Why merging is done locally
 *
 * GitHub's API can merge two branches, but `POST /repos/:o/:r/merges` fails the
 * WHOLE operation on any conflict and returns no conflict markers. There is
 * nothing to hand to an agent at that point — just "conflict", with no way to see
 * what the two sides said. Local git writes `<<<<<<<` / `=======` / `>>>>>>>`
 * into the files, which the agent can read and resolve itself. So the network is
 * used to move commits, and the merge happens on disk.
 *
 * ## Two transports, chosen by permission rather than preference
 *
 * SSH is the primary transport because it is the reliable one here (measured: 6
 * of 6 connects on `github.com:22`, versus 3 of 6 failures on `github.com:443`).
 * But a deploy key can only be installed by someone with admin rights on the
 * repository, and a collaborator on somebody else's repository does not have
 * them. So:
 *
 *   - admin on the repository  -> mint a key, install it as a deploy key, use SSH
 *   - not admin                -> use HTTPS with the token, which is what the
 *                                 collaborator's own `repo` scope is for
 *
 * The API transport is a fallback for the machine branch only, via
 * {@link module:dsh-plugin-publisher/transfer.appendTree}. It is additive
 * (`base_tree` plus an explicit parent), so a sync over the API cannot delete
 * another machine's files — the failure mode that makes a naive API sync
 * dangerous.
 *
 * @module dsh-plugin-publisher/collab-sync
 */

import {
	git,
	runGit,
	isRepository,
	currentBranch,
	hasChanges,
	readIdentity,
	setRemote,
	authenticatedUrl,
	plainUrl
} from './git.js';
import {
	verifyToken,
	getRepositoryDetail,
	createRepository,
	listDeployKeys,
	addDeployKey,
	compareBranches
} from './github.js';
import { appendTree, uploadTree, inspectBranch, isConnectivityError } from './transfer.js';
import { step, scrubSecrets } from './publish.js';
import {
	machineName,
	machineBranch,
	keyPathFor,
	keyExists,
	ensureKey,
	wireSsh,
	readSshCommand,
	listMachineBranches,
	sshUrl,
	statusLines,
	keyCommentFor,
	keyFingerprint,
	parseFullName
} from './collab.js';

/** The shared branch. Named once so no flow can disagree about it. */
const MAIN_BRANCH = 'main';

/** A push moves the whole tree, so it gets a much longer leash than a local call. */
const PUSH_TIMEOUT_MS = 600_000;

/** A fetch is the same order of magnitude as a push. */
const FETCH_TIMEOUT_MS = 300_000;

/**
 * Which repository a directory belongs to.
 *
 * Read from `origin` rather than demanded as an argument, because a directory
 * that already has a remote is the common case on the second machine — the user
 * cloned it, or the publisher made it — and asking again would be asking for
 * something already on disk.
 *
 * @param subprocess - the Host subprocess service.
 * @param directory - the repository.
 * @param signal - cancellation.
 * @returns `owner/repo`, or null.
 */
export async function readRemoteFullName(subprocess, directory, signal) {
	const result = await runGit(subprocess, ['remote', 'get-url', 'origin'], { cwd: directory, signal });
	if (result.exitCode !== 0) return null;
	return parseFullName(result.stdout.trim());
}

/** `git rev-parse -q --verify <rev>`: the object id, or null when absent. */
async function revParse(subprocess, directory, rev, signal) {
	const result = await runGit(subprocess, ['rev-parse', '-q', '--verify', rev], { cwd: directory, signal });
	return result.exitCode === 0 ? result.stdout.trim() : null;
}

/** Whether HEAD has any commit at all. An unborn HEAD cannot be merged into. */
async function hasCommit(subprocess, directory, signal) {
	return (await revParse(subprocess, directory, 'HEAD', signal)) !== null;
}

/**
 * Whether a merge is already half-finished.
 *
 * This gate matters because `git merge --abort` on a clean repository is a hard
 * error ("There is no merge to abort (MERGE_HEAD missing)"), and reporting that
 * error instead of the real state would be actively misleading.
 */
async function mergeInProgress(subprocess, directory, signal) {
	return (await revParse(subprocess, directory, 'MERGE_HEAD', signal)) !== null;
}

/** The files git left conflict markers in. */
async function conflictedFiles(subprocess, directory, signal) {
	const result = await runGit(subprocess, ['diff', '--name-only', '--diff-filter=U'], { cwd: directory, signal });
	if (result.exitCode !== 0) return [];
	return result.stdout
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/**
 * Merge one ref into the current branch.
 *
 * `--no-edit` is used so the merge never opens an editor: this runs without a
 * terminal, and a merge that waits for one would hang until the timeout rather
 * than fail informatively.
 *
 * @returns `{ ok, conflicted, files, message }` — never throws on a conflict,
 *   because a conflict is a normal outcome the agent is expected to resolve.
 */
async function mergeRef(subprocess, options) {
	const { directory, source, message, allowUnrelated = false, signal } = options;
	const args = ['merge', '--no-edit', '-m', message];
	if (allowUnrelated) args.push('--allow-unrelated-histories');
	args.push(source);

	const result = await runGit(subprocess, args, { cwd: directory, signal });
	if (result.exitCode === 0) {
		return { ok: true, conflicted: false, files: [], message: result.stdout.trim() };
	}

	const files = await conflictedFiles(subprocess, directory, signal);
	if (files.length > 0 || (await mergeInProgress(subprocess, directory, signal))) {
		return { ok: false, conflicted: true, files, message: result.stdout.trim() || result.stderr.trim() };
	}

	// A non-zero exit with no merge in progress is a real failure, not a conflict.
	return { ok: false, conflicted: false, files: [], message: (result.stderr.trim() || result.stdout.trim()).split('\n')[0] };
}

/** Stage everything and commit, when there is anything to commit. */
async function commitAll(subprocess, options) {
	const { directory, message, signal } = options;
	await git(subprocess, ['add', '-A'], { cwd: directory, signal });
	if (!(await hasChanges(subprocess, directory))) return false;
	await git(subprocess, ['commit', '-m', message], { cwd: directory, signal });
	return true;
}

/** Make sure the directory is a repository with a commit identity. */
async function ensureLocalRepo(subprocess, options) {
	const { directory, account, signal, steps } = options;
	if (!(await isRepository(subprocess, directory))) {
		await git(subprocess, ['init'], { cwd: directory, signal });
		// `-M` renames whatever the default was, so a machine configured for
		// `master` still produces a modern default branch.
		await git(subprocess, ['branch', '-M', MAIN_BRANCH], { cwd: directory, signal });
		steps.push(step('git-init', 'ok', 'initialised a new repository'));
	} else {
		const branch = await currentBranch(subprocess, directory);
		steps.push(step('git-init', 'ok', `already a repository on ${branch ?? 'an unborn branch'}`));
	}

	const identity = await readIdentity(subprocess, directory);
	if (identity.name.length === 0 || identity.email.length === 0) {
		// Local, not global: collaborating on one repository must not rewrite the
		// identity every other repository on this machine commits under.
		await git(subprocess, ['config', 'user.name', account.login], { cwd: directory, signal });
		await git(subprocess, ['config', 'user.email', `${account.login}@users.noreply.github.com`], { cwd: directory, signal });
		steps.push(step('git-identity', 'ok', `set a local commit identity for ${account.login}`));
	}
}

/**
 * Decide how this machine will reach the repository, and set it up.
 *
 * See the module comment: the choice is made by permission, not preference. An
 * administrator gets a deploy key and SSH; anyone else gets HTTPS and the token,
 * because GitHub only lets an administrator manage a repository's keys.
 *
 * @returns `{ transport, keyPath, publicKey }`.
 */
async function ensureTransport(subprocess, options) {
	const { directory, fullName, token, account, detail, machine, signal, steps } = options;

	const admin = detail.permissions?.admin === true || detail.owner === account.login;
	if (!admin) {
		await setRemote(subprocess, directory, plainUrl(fullName));
		steps.push(
			step(
				'transport',
				'ok',
				`https with the token: ${account.login} is not an administrator of ${fullName}, ` +
					'so it cannot install a deploy key there'
			)
		);
		return { transport: 'https', keyPath: null, publicKey: null };
	}

	const keyPath = keyPathFor(fullName);
	const key = await ensureKey(subprocess, { keyPath, comment: keyCommentFor(machine), signal });
	steps.push(step('ssh-key', 'ok', `${key.created ? 'generated' : 'found'} a key for this machine (${keyFingerprint(key.publicKey)})`));

	// The key material itself is the identity, not the title: a title can be
	// renamed on GitHub's page, and comparing titles would then install a second
	// copy of a key that is already there.
	const body = key.publicKey.split(/\s+/u)[1] ?? '';
	const installed = (await listDeployKeys(token, fullName)).some((entry) => (entry.key.split(/\s+/u)[1] ?? '') === body);
	if (installed) {
		steps.push(step('deploy-key', 'ok', 'this machine\'s key is already installed on the repository'));
	} else {
		await addDeployKey(token, fullName, { title: keyCommentFor(machine), key: key.publicKey, readOnly: false });
		steps.push(step('deploy-key', 'ok', 'installed this machine\'s key on the repository'));
	}

	await setRemote(subprocess, directory, sshUrl(fullName));
	await wireSsh(subprocess, { directory, keyPath, signal });
	steps.push(step('transport', 'ok', 'ssh, using this repository\'s own key'));
	return { transport: 'ssh', keyPath, publicKey: key.publicKey };
}

/** Fetch every branch into `refs/remotes/origin/*`, over whichever transport is live. */
async function fetchOrigin(subprocess, options) {
	const { directory, fullName, token, transport, signal } = options;
	const target = transport === 'ssh' ? 'origin' : authenticatedUrl(token, fullName);
	return runGit(subprocess, ['fetch', target, '+refs/heads/*:refs/remotes/origin/*'], {
		cwd: directory,
		signal,
		timeoutMs: FETCH_TIMEOUT_MS
	});
}

/**
 * Push one ref, over SSH or HTTPS, and say plainly when the network refused.
 *
 * `--force` is opt-in and is only ever passed by {@link shareProject}, whose
 * whole meaning is "this directory is now the content of this branch". Every
 * other push is a plain push, so a concurrent write from another machine is
 * rejected instead of overwritten.
 */
async function pushRef(subprocess, options) {
	const { directory, fullName, token, transport, refspec, signal, setUpstream = false, force = false } = options;
	const args = ['push'];
	if (force) args.push('--force');
	if (setUpstream) args.push('-u');
	args.push(transport === 'ssh' ? 'origin' : authenticatedUrl(token, fullName));
	args.push(refspec);
	return runGit(subprocess, args, { cwd: directory, signal, timeoutMs: PUSH_TIMEOUT_MS });
}

/**
 * Push the machine branch, falling back to the API when the network refuses.
 *
 * The fallback is additive by construction (see `appendTree`), so it can only
 * ever ADD this machine's files on top of whatever is already on the branch. That
 * is the property that makes it safe to use automatically.
 *
 * @returns `{ pushed, transport, detail, commit }`.
 */
async function pushMachineBranch(subprocess, options) {
	const { directory, fullName, owner, repo, token, transport, branch, signal } = options;

	const result = await pushRef(subprocess, {
		directory,
		fullName,
		token,
		transport,
		refspec: `refs/heads/${branch}:refs/heads/${branch}`,
		signal,
		setUpstream: transport === 'ssh'
	});
	if (result.exitCode === 0) {
		return { pushed: true, transport, detail: 'pushed' };
	}

	if (!isConnectivityError(result.stderr)) {
		return { pushed: false, transport, detail: (result.stderr.trim() || 'git push failed').split('\n')[0] };
	}

	// The git host is unreachable but api.github.com is not: write the same commit
	// through the git-data endpoints instead.
	try {
		const appended = await appendTree({
			token,
			owner,
			repo,
			branch,
			subprocess,
			directory,
			message: `chore: sync ${branch} from ${machineName()}`
		});
		return {
			pushed: true,
			transport: 'api',
			detail: `${String(appended.fileCount)} file(s) appended over the API; git could not reach the server`,
			commit: appended.commit
		};
	} catch (error) {
		return { pushed: false, transport, detail: `git push failed and the API fallback also failed: ${scrubSecrets(String(error.message))}` };
	}
}

/**
 * Finish a merge that is already in progress.
 *
 * Called when a previous run left conflict markers and the agent has since edited
 * the files. If anything is still unmerged this reports the files instead of
 * committing a half-resolved tree.
 */
async function finishIfMerging(subprocess, options) {
	const { directory, signal } = options;
	if (!(await mergeInProgress(subprocess, directory, signal))) return { wasMerging: false };

	const files = await conflictedFiles(subprocess, directory, signal);
	if (files.length > 0) return { wasMerging: true, finished: false, files };

	await git(subprocess, ['commit', '--no-edit'], { cwd: directory, signal });
	return { wasMerging: true, finished: true, files: [] };
}

/** The `ok`/`failed` envelope every flow returns, so the tools render uniformly. */
function result(ok, steps, extra) {
	return { ok, steps, ...extra };
}

/**
 * Join a project on this machine.
 *
 * What it does, in order: sign in, work out which repository, mint or find this
 * machine's key and install it, point `origin` at the right URL, fetch, create
 * this machine's own branch, fold the project's `main` into it, and push.
 *
 * The merge of `main` into the new branch is where local files meet the remote
 * ones. When they touch the same lines git writes conflict markers and this stops
 * with the file list — the agent resolves them and calls this again, which
 * detects the unfinished merge and finishes it rather than starting a second one.
 *
 * @param options - `subprocess`, `directory`, `token`, `owner`, `repo`, `machine`,
 *   `signal`.
 * @returns `{ ok, steps, project }`.
 */
export async function joinProject(options) {
	const { subprocess, directory, token, signal } = options;
	const steps = [];

	let account;
	try {
		account = await verifyToken(token);
		steps.push(step('token', 'ok', `signed in as ${account.login}`));
	} catch (error) {
		steps.push(step('token', 'failed', scrubSecrets(String(error.message))));
		return result(false, steps, { project: null });
	}

	// --- which repository ----------------------------------------------------
	let fullName = options.owner !== undefined && options.repo !== undefined ? `${options.owner}/${options.repo}` : null;
	if (fullName === null) fullName = await readRemoteFullName(subprocess, directory, signal);
	if (fullName === null) {
		steps.push(
			step(
				'repository',
				'failed',
				'this directory has no origin remote, so there is no way to tell which repository to join. ' +
					'Pass owner and repo, or clone the repository first.'
			)
		);
		return result(false, steps, { project: null });
	}

	const [owner, repo] = fullName.split('/');
	let detail;
	try {
		detail = await getRepositoryDetail(token, fullName);
	} catch (error) {
		steps.push(step('repository', 'failed', scrubSecrets(String(error.message))));
		return result(false, steps, { project: null });
	}
	if (detail === null) {
		steps.push(step('repository', 'failed', `${fullName} does not exist, or this token cannot see it.`));
		return result(false, steps, { project: null });
	}
	steps.push(step('repository', 'ok', `${fullName} (${detail.visibility})`));

	const machine = machineName(options.machine);
	const branch = machineBranch(machine);
	steps.push(step('machine', 'ok', `this machine is "${machine}", so its branch is "${branch}"`));

	// --- local repository ----------------------------------------------------
	try {
		await ensureLocalRepo(subprocess, { directory, account, signal, steps });
		const committed = await commitAll(subprocess, {
			directory,
			message: `chore: local work on ${machine} before joining ${fullName}`,
			signal
		});
		if (committed) steps.push(step('git-commit', 'ok', 'committed the local files as a starting point'));
	} catch (error) {
		steps.push(step('git-local', 'failed', scrubSecrets(String(error.message))));
		return result(false, steps, { project: null });
	}

	// --- credential and remote ----------------------------------------------
	let wiring;
	try {
		wiring = await ensureTransport(subprocess, { directory, fullName, token, account, detail, machine, signal, steps });
	} catch (error) {
		const message = scrubSecrets(String(error.message));
		steps.push(step('transport', 'failed', error.hint === undefined ? message : `${message} ${error.hint}`));
		return result(false, steps, { project: null });
	}

	// --- fetch ---------------------------------------------------------------
	try {
		const fetched = await fetchOrigin(subprocess, { directory, fullName, token, transport: wiring.transport, signal });
		if (fetched.exitCode !== 0) {
			const detailText = (fetched.stderr.trim() || 'git fetch failed').split('\n')[0];
			steps.push(step('fetch', 'failed', detailText));
			return result(false, steps, { project: null });
		}
		steps.push(step('fetch', 'ok', 'read the branches that already exist on the repository'));
	} catch (error) {
		steps.push(step('fetch', 'failed', scrubSecrets(String(error.message))));
		return result(false, steps, { project: null });
	}

	// --- this machine's branch ----------------------------------------------
	const remoteMain = await revParse(subprocess, directory, `refs/remotes/origin/${MAIN_BRANCH}`, signal);
	const ownBranch = await revParse(subprocess, directory, `refs/remotes/origin/${branch}`, signal);

	try {
		if (ownBranch !== null) {
			// The branch already exists on the repository, so this machine is
			// rejoining a project it has worked on. Starting it over from main would
			// throw away that machine's own committed work.
			await git(subprocess, ['checkout', '-B', branch, `refs/remotes/origin/${branch}`], { cwd: directory, signal });
			steps.push(step('branch', 'ok', `"${branch}" already exists on the repository; continuing on it`));
		} else if (!(await hasCommit(subprocess, directory, signal)) && remoteMain !== null) {
			// Nothing local at all: start the branch from the project's main.
			await git(subprocess, ['checkout', '-B', branch, `refs/remotes/origin/${MAIN_BRANCH}`], { cwd: directory, signal });
			steps.push(step('branch', 'ok', `created "${branch}" from ${MAIN_BRANCH}`));
		} else {
			await git(subprocess, ['checkout', '-B', branch], { cwd: directory, signal });
			steps.push(step('branch', 'ok', `created "${branch}" from the local files`));
		}
	} catch (error) {
		steps.push(step('branch', 'failed', scrubSecrets(String(error.message))));
		return result(false, steps, { project: null });
	}

	// --- fold in the project's main -----------------------------------------
	let conflicted = [];
	if (remoteMain !== null && (await revParse(subprocess, directory, `refs/remotes/origin/${MAIN_BRANCH}`, signal)) !== null) {
		const alreadyMerging = await finishIfMerging(subprocess, { directory, signal });
		if (alreadyMerging.wasMerging && alreadyMerging.finished === false) {
			steps.push(
				step(
					'merge-main',
					'failed',
					`${String(alreadyMerging.files.length)} file(s) still have conflict markers: ${alreadyMerging.files.join(', ')}`
				)
			);
			return result(false, steps, { project: { fullName, machine, branch, transport: wiring.transport, publicKey: wiring.publicKey, conflicted: alreadyMerging.files, pushed: false } });
		}
		if (alreadyMerging.wasMerging) {
			steps.push(step('merge-main', 'ok', 'finished the merge that was already in progress'));
		} else if ((await revParse(subprocess, directory, `refs/remotes/origin/${MAIN_BRANCH}`, signal)) !== null) {
			const merged = await mergeRef(subprocess, {
				directory,
				source: `refs/remotes/origin/${MAIN_BRANCH}`,
				message: `chore: join ${fullName} onto ${branch}`,
				// The local snapshot and the repository's history are separate roots
				// until this merge, which is exactly what this flag is for.
				allowUnrelated: true,
				signal
			});
			if (merged.conflicted) {
				conflicted = merged.files;
				steps.push(
					step(
						'merge-main',
						'failed',
						`${String(merged.files.length)} file(s) conflict between the local files and ${MAIN_BRANCH}: ${merged.files.join(', ')}. ` +
							'Edit them to remove the <<<<<<< / ======= / >>>>>>> markers, then run this again.'
					)
				);
				return result(false, steps, { project: { fullName, machine, branch, transport: wiring.transport, publicKey: wiring.publicKey, conflicted, pushed: false } });
			}
			if (!merged.ok) {
				steps.push(step('merge-main', 'failed', merged.message));
				return result(false, steps, { project: null });
			}
			steps.push(step('merge-main', 'ok', `brought ${MAIN_BRANCH} into ${branch}`));
		}
	} else {
		steps.push(step('merge-main', 'warn', `the repository has no "${MAIN_BRANCH}" branch yet, so there was nothing to bring in`));
	}

	// --- publish this machine's branch --------------------------------------
	const pushed = await pushMachineBranch(subprocess, { directory, fullName, owner, repo, token, transport: wiring.transport, branch, signal });
	steps.push(step('push', pushed.pushed ? 'ok' : 'failed', pushed.pushed ? `${branch} -> ${fullName} (${pushed.transport})` : pushed.detail));
	if (!pushed.pushed) {
		return result(false, steps, { project: { fullName, machine, branch, transport: wiring.transport, publicKey: wiring.publicKey, conflicted, pushed: false } });
	}

	return result(true, steps, {
		project: {
			fullName,
			machine,
			branch,
			transport: pushed.transport,
			publicKey: wiring.publicKey,
			keyPath: wiring.keyPath,
			conflicted,
			pushed: true
		}
	});
}

/**
 * Turn this directory into a shared project.
 *
 * This is the one flow that writes to `main`, and it is the act of saying "this
 * directory is the project". It keeps the publisher's overwrite guard: if `main`
 * already holds real commits, nothing is written unless `replaceExisting` is set,
 * because a replace upload deletes every other machine's commits.
 *
 * After `main` is in place it also creates this machine's own branch from it, so
 * the machine has somewhere of its own to work immediately.
 *
 * @param options - `subprocess`, `directory`, `token`, `owner`, `repo`,
 *   `description`, `private`, `replaceExisting`, `collaborator`, `machine`,
 *   `signal`.
 * @returns `{ ok, steps, project }`.
 */
export async function shareProject(options) {
	const { subprocess, directory, token, signal, replaceExisting = false } = options;
	const steps = [];

	let account;
	try {
		account = await verifyToken(token);
		steps.push(step('token', 'ok', `signed in as ${account.login}`));
	} catch (error) {
		steps.push(step('token', 'failed', scrubSecrets(String(error.message))));
		return result(false, steps, { project: null });
	}

	// --- which repository, creating it when it is not there yet -------------
	let fullName = options.owner !== undefined && options.repo !== undefined ? `${options.owner}/${options.repo}` : null;
	if (fullName === null) fullName = await readRemoteFullName(subprocess, directory, signal);
	if (fullName === null) {
		steps.push(step('repository', 'failed', 'no repository was given and this directory has no origin remote to read one from.'));
		return result(false, steps, { project: null });
	}

	const [owner, repo] = fullName.split('/');
	let detail = await getRepositoryDetail(token, fullName);
	if (detail === null) {
		const created = await createRepository(token, {
			name: repo,
			description: options.description,
			private: options.private === true
		});
		detail = await getRepositoryDetail(token, created.fullName);
		steps.push(step('repository', 'ok', `created ${created.fullName}`));
	} else {
		steps.push(step('repository', 'ok', `${fullName} already exists (${detail.visibility})`));
	}

	const machine = machineName(options.machine);
	const branch = machineBranch(machine);

	// --- local repository ----------------------------------------------------
	try {
		await ensureLocalRepo(subprocess, { directory, account, signal, steps });
		const committed = await commitAll(subprocess, { directory, message: `chore: share ${fullName}`, signal });
		steps.push(step('git-commit', committed ? 'ok' : 'ok', committed ? 'committed the working tree' : 'nothing new to commit'));
	} catch (error) {
		steps.push(step('git-local', 'failed', scrubSecrets(String(error.message))));
		return result(false, steps, { project: null });
	}

	// --- credential and remote ----------------------------------------------
	let wiring;
	try {
		wiring = await ensureTransport(subprocess, { directory, fullName, token, account, detail, machine, signal, steps });
	} catch (error) {
		const message = scrubSecrets(String(error.message));
		steps.push(step('transport', 'failed', error.hint === undefined ? message : `${message} ${error.hint}`));
		return result(false, steps, { project: null });
	}

	// --- the overwrite guard, exactly as publish applies it ------------------
	try {
		const state = await inspectBranch(token, owner, repo, MAIN_BRANCH);
		if (state.exists && !state.onlyInitial && !replaceExisting) {
			steps.push(
				step(
					'overwrite',
					'failed',
					`"${MAIN_BRANCH}" already has commits, and sharing this directory would replace them — including any other machine's work. ` +
						'Nothing was changed. Pass replace_existing to overwrite, or use join_project to add this machine to the existing project.'
				)
			);
			return result(false, steps, { project: null });
		}
		if (state.exists && !state.onlyInitial) {
			steps.push(step('overwrite', 'warn', `replacing the existing commits on "${MAIN_BRANCH}" as requested`));
		}
	} catch (error) {
		steps.push(step('overwrite', 'warn', `could not check "${MAIN_BRANCH}": ${scrubSecrets(String(error.message))}`));
	}

	// --- main ----------------------------------------------------------------
	try {
		await git(subprocess, ['checkout', '-B', MAIN_BRANCH], { cwd: directory, signal });
	} catch (error) {
		steps.push(step('branch', 'failed', scrubSecrets(String(error.message))));
		return result(false, steps, { project: null });
	}

	const mainPush = await pushRef(subprocess, {
		directory,
		fullName,
		token,
		transport: wiring.transport,
		refspec: `refs/heads/${MAIN_BRANCH}:refs/heads/${MAIN_BRANCH}`,
		signal,
		setUpstream: wiring.transport === 'ssh',
		// Sharing means "this directory is the content of main", which is the same
		// replace semantics publishing has. The guard above already ran.
		force: true
	});
	if (mainPush.exitCode === 0) {
		steps.push(step('push-main', 'ok', `${MAIN_BRANCH} -> ${fullName} (${wiring.transport})`));
	} else if (isConnectivityError(mainPush.stderr)) {
		try {
			const uploaded = await uploadTree({
				token,
				owner,
				repo,
				branch: MAIN_BRANCH,
				subprocess,
				directory,
				message: `chore: share ${fullName}`,
				replaceExisting: true
			});
			steps.push(step('push-main', 'warn', `${String(uploaded.fileCount)} file(s) written over the API; git could not reach the server`));
		} catch (error) {
			steps.push(step('push-main', 'failed', scrubSecrets(String(error.message))));
			return result(false, steps, { project: null });
		}
	} else {
		steps.push(step('push-main', 'failed', (mainPush.stderr.trim() || 'git push failed').split('\n')[0]));
		return result(false, steps, { project: null });
	}

	// --- this machine's own branch ------------------------------------------
	try {
		await git(subprocess, ['checkout', '-B', branch], { cwd: directory, signal });
	} catch (error) {
		steps.push(step('branch', 'failed', scrubSecrets(String(error.message))));
		return result(false, steps, { project: null });
	}

	const pushed = await pushMachineBranch(subprocess, { directory, fullName, owner, repo, token, transport: wiring.transport, branch, signal });
	steps.push(step('push', pushed.pushed ? 'ok' : 'failed', pushed.pushed ? `${branch} -> ${fullName} (${pushed.transport})` : pushed.detail));

	// --- invite a second person, when one was named -------------------------
	if (typeof options.collaborator === 'string' && options.collaborator.trim().length > 0) {
		try {
			const invited = await addCollaborator(token, fullName, options.collaborator.trim());
			steps.push(
				step(
					'collaborator',
					'ok',
					`invited ${invited.login} with "${invited.permission}" permission; they must accept before their machine can push`
				)
			);
		} catch (error) {
			const message = scrubSecrets(String(error.message));
			steps.push(step('collaborator', 'failed', error.hint === undefined ? message : `${message} ${error.hint}`));
		}
	}

	return result(pushed.pushed, steps, {
		project: {
			fullName,
			machine,
			branch,
			transport: pushed.transport,
			publicKey: wiring.publicKey,
			keyPath: wiring.keyPath,
			conflicted: [],
			pushed: pushed.pushed
		}
	});
}

/**
 * Move this machine's work up, and everybody else's work down.
 *
 * Two directions, one command, because doing only one of them is how a machine
 * ends up diverged and confused:
 *
 *   - **down**: merge `origin/main` into this machine's branch
 *   - **up**: push this machine's branch
 *
 * It always lands on the machine branch first. Committing local work onto `main`
 * would make `main` a local branch that other machines cannot see, which is
 * precisely the confusion the branch-per-machine rule exists to prevent.
 *
 * @param options - `subprocess`, `directory`, `token`, `machine`, `message`,
 *   `push` (defaults to true), `signal`.
 * @returns `{ ok, steps, project }`.
 */
export async function syncProject(options) {
	const { subprocess, directory, token, signal, push = true } = options;
	const steps = [];

	let account;
	try {
		account = await verifyToken(token);
		steps.push(step('token', 'ok', `signed in as ${account.login}`));
	} catch (error) {
		steps.push(step('token', 'failed', scrubSecrets(String(error.message))));
		return result(false, steps, { project: null });
	}

	let fullName = options.owner !== undefined && options.repo !== undefined ? `${options.owner}/${options.repo}` : null;
	if (fullName === null) fullName = await readRemoteFullName(subprocess, directory, signal);
	if (fullName === null) {
		steps.push(step('repository', 'failed', 'this directory has no origin remote. Join or share the project first.'));
		return result(false, steps, { project: null });
	}

	const [owner, repo] = fullName.split('/');
	const detail = await getRepositoryDetail(token, fullName);
	if (detail === null) {
		steps.push(step('repository', 'failed', `${fullName} does not exist, or this token cannot see it.`));
		return result(false, steps, { project: null });
	}

	const machine = machineName(options.machine);
	const branch = machineBranch(machine);

	// --- land on this machine's branch --------------------------------------
	try {
		if (!(await isRepository(subprocess, directory))) {
			steps.push(step('git-init', 'failed', 'this directory is not a repository yet. Run join_project first.'));
			return result(false, steps, { project: null });
		}
		await ensureLocalRepo(subprocess, { directory, account, signal, steps });
		await git(subprocess, ['checkout', '-B', branch], { cwd: directory, signal });
		const committed = await commitAll(subprocess, {
			directory,
			message: options.message ?? `chore: work from ${machine}`,
			signal
		});
		steps.push(step('git-commit', 'ok', committed ? `committed the working tree onto ${branch}` : 'nothing new to commit'));
	} catch (error) {
		steps.push(step('git-local', 'failed', scrubSecrets(String(error.message))));
		return result(false, steps, { project: null });
	}

	// --- credential, remote, fetch ------------------------------------------
	let wiring;
	try {
		wiring = await ensureTransport(subprocess, { directory, fullName, token, account, detail, machine, signal, steps });
		const fetched = await fetchOrigin(subprocess, { directory, fullName, token, transport: wiring.transport, signal });
		if (fetched.exitCode !== 0) {
			steps.push(step('fetch', 'failed', (fetched.stderr.trim() || 'git fetch failed').split('\n')[0]));
			return result(false, steps, { project: null });
		}
		steps.push(step('fetch', 'ok', 'read the latest branches from the repository'));
	} catch (error) {
		const message = scrubSecrets(String(error.message));
		steps.push(step('transport', 'failed', error.hint === undefined ? message : `${message} ${error.hint}`));
		return result(false, steps, { project: null });
	}

	// --- an unfinished merge is finished, not restarted ---------------------
	const pending = await finishIfMerging(subprocess, { directory, signal });
	if (pending.wasMerging && pending.finished === false) {
		steps.push(step('merge-main', 'failed', `${String(pending.files.length)} file(s) still have conflict markers: ${pending.files.join(', ')}`));
		return result(false, steps, {
			project: { fullName, machine, branch, transport: wiring.transport, conflicted: pending.files, pushed: false }
		});
	}
	if (pending.wasMerging) steps.push(step('merge-main', 'ok', 'finished the merge that was already in progress'));

	// --- down: fold main into this branch -----------------------------------
	const remoteMain = await revParse(subprocess, directory, `refs/remotes/origin/${MAIN_BRANCH}`, signal);
	let conflicted = [];
	if (remoteMain !== null) {
		const merged = await mergeRef(subprocess, {
			directory,
			source: `refs/remotes/origin/${MAIN_BRANCH}`,
			message: `chore: bring ${MAIN_BRANCH} into ${branch}`,
			signal
		});
		if (merged.conflicted) {
			conflicted = merged.files;
			steps.push(
				step(
					'merge-main',
					'failed',
					`${String(merged.files.length)} file(s) conflict between ${branch} and ${MAIN_BRANCH}: ${merged.files.join(', ')}. ` +
						'Edit them to remove the <<<<<<< / ======= / >>>>>>> markers, then run sync_project again.'
				)
			);
			return result(false, steps, { project: { fullName, machine, branch, transport: wiring.transport, conflicted, pushed: false } });
		}
		if (!merged.ok) {
			steps.push(step('merge-main', 'failed', merged.message));
			return result(false, steps, { project: null });
		}
		steps.push(step('merge-main', 'ok', `brought ${MAIN_BRANCH} into ${branch}`));
	} else {
		steps.push(step('merge-main', 'warn', `the repository has no "${MAIN_BRANCH}" branch yet`));
	}

	// --- up: publish this branch --------------------------------------------
	if (push === false) {
		steps.push(step('push', 'warn', 'skipped, as requested'));
		return result(true, steps, {
			project: { fullName, machine, branch, transport: wiring.transport, conflicted, pushed: false }
		});
	}

	const pushed = await pushMachineBranch(subprocess, { directory, fullName, owner, repo, token, transport: wiring.transport, branch, signal });
	steps.push(step('push', pushed.pushed ? 'ok' : 'failed', pushed.pushed ? `${branch} -> ${fullName} (${pushed.transport})` : pushed.detail));

	return result(pushed.pushed, steps, {
		project: { fullName, machine, branch, transport: pushed.transport, conflicted, pushed: pushed.pushed }
	});
}

/**
 * Merge other machines' branches into one branch.
 *
 * `into: 'machine'` (the default) integrates their work into this machine's own
 * branch, so this machine can see and test the combined result without touching
 * anything shared. `into: 'main'` is the act of agreeing on a result: it starts
 * from the repository's `main` and merges each machine branch in turn.
 *
 * A conflict stops the run at the branch that caused it and leaves the markers in
 * the working tree. That is deliberate: continuing would stack a second conflict
 * on top of an unresolved first one, and the agent would be reading two sets of
 * markers in the same file.
 *
 * @param options - `subprocess`, `directory`, `token`, `branches`, `into`
 *   (`machine` or `main`), `push`, `machine`, `signal`.
 * @returns `{ ok, steps, project }`.
 */
export async function mergeProject(options) {
	const { subprocess, directory, token, signal, into = 'machine', push = false } = options;
	const steps = [];

	let account;
	try {
		account = await verifyToken(token);
		steps.push(step('token', 'ok', `signed in as ${account.login}`));
	} catch (error) {
		steps.push(step('token', 'failed', scrubSecrets(String(error.message))));
		return result(false, steps, { project: null });
	}

	let fullName = options.owner !== undefined && options.repo !== undefined ? `${options.owner}/${options.repo}` : null;
	if (fullName === null) fullName = await readRemoteFullName(subprocess, directory, signal);
	if (fullName === null) {
		steps.push(step('repository', 'failed', 'this directory has no origin remote. Join or share the project first.'));
		return result(false, steps, { project: null });
	}

	const [owner, repo] = fullName.split('/');
	const detail = await getRepositoryDetail(token, fullName);
	if (detail === null) {
		steps.push(step('repository', 'failed', `${fullName} does not exist, or this token cannot see it.`));
		return result(false, steps, { project: null });
	}

	const machine = machineName(options.machine);
	const ownBranch = machineBranch(machine);
	const target = into === 'main' ? MAIN_BRANCH : ownBranch;

	// --- credential, remote, fetch ------------------------------------------
	let wiring;
	try {
		wiring = await ensureTransport(subprocess, { directory, fullName, token, account, detail, machine, signal, steps });
		const fetched = await fetchOrigin(subprocess, { directory, fullName, token, transport: wiring.transport, signal });
		if (fetched.exitCode !== 0) {
			steps.push(step('fetch', 'failed', (fetched.stderr.trim() || 'git fetch failed').split('\n')[0]));
			return result(false, steps, { project: null });
		}
		steps.push(step('fetch', 'ok', 'read the latest branches from the repository'));
	} catch (error) {
		const message = scrubSecrets(String(error.message));
		steps.push(step('transport', 'failed', error.hint === undefined ? message : `${message} ${error.hint}`));
		return result(false, steps, { project: null });
	}

	// --- which branches to merge --------------------------------------------
	let sources = Array.isArray(options.branches) ? options.branches.map((name) => String(name)) : [];
	if (sources.length === 0) {
		let remote;
		try {
			remote = await listMachineBranches(subprocess, { directory, signal });
		} catch (error) {
			steps.push(step('branches', 'failed', scrubSecrets(String(error.message))));
			return result(false, steps, { project: null });
		}
		sources = remote.map((entry) => entry.branch);
	}
	// The target is never its own source, and a bare machine name is accepted so a
	// caller does not have to know the prefix.
	sources = sources
		.map((name) => (name.startsWith('machine/') ? name : machineBranch(name)))
		.filter((name) => name !== target);
	if (sources.length === 0) {
		steps.push(step('branches', 'warn', 'there are no other machine branches to merge'));
		return result(true, steps, {
			project: { fullName, machine, branch: target, transport: wiring.transport, conflicted: [], pushed: false }
		});
	}
	steps.push(step('branches', 'ok', `merging into "${target}": ${sources.join(', ')}`));

	// --- land on the target branch ------------------------------------------
	try {
		if (target === MAIN_BRANCH) {
			// Start from the repository's main, not from a stale local one.
			const remoteMain = await revParse(subprocess, directory, `refs/remotes/origin/${MAIN_BRANCH}`, signal);
			await git(subprocess, ['checkout', '-B', MAIN_BRANCH, ...(remoteMain === null ? [] : [`refs/remotes/origin/${MAIN_BRANCH}`])], {
				cwd: directory,
				signal
			});
		} else {
			await git(subprocess, ['checkout', '-B', target], { cwd: directory, signal });
		}
	} catch (error) {
		steps.push(step('branch', 'failed', `${scrubSecrets(String(error.message))} Commit or stash the working tree first.`));
		return result(false, steps, { project: null });
	}

	// --- an unfinished merge is finished, not restarted ---------------------
	const pending = await finishIfMerging(subprocess, { directory, signal });
	if (pending.wasMerging && pending.finished === false) {
		steps.push(step('merge', 'failed', `${String(pending.files.length)} file(s) still have conflict markers: ${pending.files.join(', ')}`));
		return result(false, steps, {
			project: { fullName, machine, branch: target, transport: wiring.transport, conflicted: pending.files, pushed: false }
		});
	}
	if (pending.wasMerging) steps.push(step('merge', 'ok', 'finished the merge that was already in progress'));

	// --- merge each source in turn ------------------------------------------
	const merged = [];
	for (const source of sources) {
		const exists = await revParse(subprocess, directory, `refs/remotes/origin/${source}`, signal);
		if (exists === null) {
			steps.push(step('merge', 'warn', `"${source}" is not on the repository; skipped`));
			continue;
		}
		const outcome = await mergeRef(subprocess, {
			directory,
			source: `refs/remotes/origin/${source}`,
			message: `chore: merge ${source} into ${target}`,
			signal
		});
		if (outcome.conflicted) {
			steps.push(
				step(
					'merge',
					'failed',
					`"${source}" conflicts with "${target}" in ${String(outcome.files.length)} file(s): ${outcome.files.join(', ')}. ` +
						'Edit them to remove the <<<<<<< / ======= / >>>>>>> markers, then run merge_project again.'
				)
			);
			return result(false, steps, {
				project: {
					fullName,
					machine,
					branch: target,
					transport: wiring.transport,
					conflicted: outcome.files,
					merged,
					pushed: false
				}
			});
		}
		if (!outcome.ok) {
			steps.push(step('merge', 'failed', `"${source}": ${outcome.message}`));
			return result(false, steps, { project: { fullName, machine, branch: target, transport: wiring.transport, conflicted: [], merged, pushed: false } });
		}
		merged.push(source);
		steps.push(step('merge', 'ok', `${source} -> ${target}`));
	}

	// --- optionally publish the result --------------------------------------
	if (push !== true) {
		steps.push(step('push', 'warn', `"${target}" was updated locally only; pass push to publish it`));
		return result(true, steps, {
			project: { fullName, machine, branch: target, transport: wiring.transport, conflicted: [], merged, pushed: false }
		});
	}

	let pushed;
	if (target === MAIN_BRANCH) {
		const outcome = await pushRef(subprocess, {
			directory,
			fullName,
			token,
			transport: wiring.transport,
			refspec: `refs/heads/${MAIN_BRANCH}:refs/heads/${MAIN_BRANCH}`,
			signal
		});
		pushed = {
			pushed: outcome.exitCode === 0,
			transport: wiring.transport,
			detail: (outcome.stderr.trim() || 'git push failed').split('\n')[0]
		};
		if (!pushed.pushed) {
			pushed.detail =
				`${pushed.detail} Run sync_project on this machine first if another machine has moved "${MAIN_BRANCH}" since this merge started.`;
		}
	} else {
		pushed = await pushMachineBranch(subprocess, { directory, fullName, owner, repo, token, transport: wiring.transport, branch: target, signal });
	}
	steps.push(step('push', pushed.pushed ? 'ok' : 'failed', pushed.pushed ? `${target} -> ${fullName} (${pushed.transport})` : pushed.detail));

	return result(pushed.pushed, steps, {
		project: { fullName, machine, branch: target, transport: pushed.transport, conflicted: [], merged, pushed: pushed.pushed }
	});
}

/**
 * Report where this machine stands, without changing anything.
 *
 * Read-only by design: the first question after a confusing merge is "what state
 * am I actually in", and answering it must not be able to make things worse.
 *
 * @param options - `subprocess`, `directory`, `token`, `owner`, `repo`, `machine`,
 *   `signal`.
 * @returns `{ ok, steps, project }`.
 */
export async function projectStatus(options) {
	const { subprocess, directory, token, signal } = options;
	const steps = [];

	let account = null;
	try {
		account = await verifyToken(token);
		steps.push(step('token', 'ok', `signed in as ${account.login}`));
	} catch (error) {
		steps.push(step('token', 'failed', scrubSecrets(String(error.message))));
	}

	let fullName = options.owner !== undefined && options.repo !== undefined ? `${options.owner}/${options.repo}` : null;
	if (fullName === null) fullName = await readRemoteFullName(subprocess, directory, signal);

	const machine = machineName(options.machine);
	const branch = machineBranch(machine);
	const isRepo = await isRepository(subprocess, directory);
	const current = isRepo ? await currentBranch(subprocess, directory) : null;
	const dirty = isRepo ? await statusLines(subprocess, directory) : [];
	const ssh = isRepo ? await readSshCommand(subprocess, directory) : null;
	const merging = isRepo ? await mergeInProgress(subprocess, directory, signal) : false;

	steps.push(step('repository', fullName === null ? 'warn' : 'ok', fullName ?? 'this directory has no origin remote'));
	steps.push(step('machine', 'ok', `"${machine}" (branch "${branch}")`));
	steps.push(step('local', isRepo ? 'ok' : 'warn', isRepo ? `on "${current ?? 'an unborn branch'}", ${String(dirty.length)} uncommitted path(s)` : 'not a repository yet'));
	steps.push(step('transport', ssh === null ? 'warn' : 'ok', ssh ?? 'no per-repository SSH key is wired up (HTTPS with the token, or not set up yet)'));

	let keyPath = null;
	if (fullName !== null) {
		keyPath = keyPathFor(fullName);
		const present = await keyExists(subprocess, keyPath);
		steps.push(step('ssh-key', present ? 'ok' : 'warn', present ? keyPath : `no key at ${keyPath} yet`));
	}
	if (merging) {
		steps.push(step('merge', 'warn', 'a merge is in progress; resolve the conflict markers and run sync_project or merge_project to finish it'));
	}

	// --- what the repository has --------------------------------------------
	let branches = [];
	let comparison = null;
	let detail = null;
	if (fullName !== null) {
		detail = await getRepositoryDetail(token, fullName);
		if (detail === null) {
			steps.push(step('remote', 'failed', `${fullName} does not exist, or this token cannot see it.`));
		} else if (isRepo) {
			try {
				branches = await listMachineBranches(subprocess, { directory, signal });
				steps.push(step('remote', 'ok', `${String(branches.length)} machine branch(es) on ${fullName}`));
			} catch (error) {
				steps.push(step('remote', 'warn', scrubSecrets(String(error.message))));
			}
			const mine = branches.some((entry) => entry.branch === branch);
			if (mine) {
				try {
					comparison = await compareBranches(token, fullName, MAIN_BRANCH, branch);
					steps.push(
						step(
							'compare',
							comparison.status === 'diverged' ? 'warn' : 'ok',
							`${branch} is ${String(comparison.aheadBy)} commit(s) ahead of and ${String(comparison.behindBy)} behind ${MAIN_BRANCH} (${comparison.status})`
						)
					);
				} catch (error) {
					steps.push(step('compare', 'warn', scrubSecrets(String(error.message))));
				}
			} else {
				steps.push(step('compare', 'warn', `"${branch}" is not on the repository yet; run join_project or share_project`));
			}
		}
	}

	return result(true, steps, {
		project: {
			fullName,
			machine,
			branch,
			current,
			dirty,
			ssh,
			keyPath,
			merging,
			branches,
			comparison,
			visibility: detail?.visibility ?? null
		}
	});
}
