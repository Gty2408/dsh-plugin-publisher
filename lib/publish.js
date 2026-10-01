/**
 * The publish flow: one plugin directory to a listing pull request.
 *
 * The steps are ordered so that nothing irreversible happens before the
 * reversible checks pass, and so that a failure leaves the user with a clear
 * statement of what was and was not done:
 *
 *   1. preflight        — local only, changes nothing
 *   2. verify token     — read-only, proves the credential works
 *   3. git init/commit  — local only
 *   4. create repo      — the first irreversible step, so it comes after 1-3
 *   5. push
 *   6. fork + submit PR — optional, and only when the user asked for it
 *
 * Every step reports a result, so a partial failure is described rather than
 * hidden. The flow never throws away what it accomplished: if the push succeeded
 * and the pull request failed, the repository is still published and the message
 * says so.
 *
 * ## On the token
 *
 * The token is embedded in the remote URL for the push and removed immediately
 * afterwards. It is never written to `.git/config` in a way that survives, never
 * included in a returned message, and scrubbed from any error text — because an
 * error message is the most likely place for a secret to leak into a log.
 *
 * @module dsh-plugin-publisher/publish
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { preflight, renderSubmissionYaml } from './preflight.js';
import {
	verifyToken,
	createRepository,
	getRepository,
	setTopics,
	DEFAULT_TOPICS,
	MARKET_OWNER,
	MARKET_REPO
} from './github.js';
import { isConnectivityError, uploadTree, openSubmissionPr } from './transfer.js';
import {
	isRepository,
	hasChanges,
	currentBranch,
	setRemote,
	git,
	authenticatedUrl,
	plainUrl,
	readIdentity
} from './git.js';

/**
 * Remove any credential from text before it is shown or logged.
 *
 * GitHub tokens are long and distinctive, and the failure paths are exactly where
 * a URL containing one tends to end up in a message.
 *
 * @param text - candidate text.
 * @returns the text with token-shaped substrings replaced.
 */
export function scrubSecrets(text) {
	if (typeof text !== 'string') return text;
	return text
		// A token embedded in an https URL.
		.replace(/https:\/\/[^@\s]+@github\.com/gu, 'https://<redacted>@github.com')
		// Classic and fine-grained token shapes.
		.replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/gu, 'gh?_<redacted>')
		.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu, 'github_pat_<redacted>');
}

/** A step record, so the caller can show exactly how far the flow got. */
function step(name, status, detail) {
	return { name, status, ...(detail === undefined ? {} : { detail }) };
}

/**
 * Publish one plugin directory.
 *
 * @param options - `subprocess`, `directory`, `token`, `owner`, `repo`, `category`,
 *   `description`, `descriptionZh`, `submit` (open the listing PR), `dryRun`,
 *   `private`, `signal`.
 * @returns `{ ok, steps, report, published, pullRequest }`.
 */
export async function publish(options) {
	const {
		subprocess,
		directory,
		token,
		owner,
		repo,
		category,
		description,
		descriptionZh,
		// Defaults to false. This plugin exists so the agent can publish its own
		// work for installation on another machine; a marketplace listing is a
		// separate decision with its own requirements.
		submit = false,
		dryRun = false,
		private: isPrivate = false,
		signal
	} = options;

	const steps = [];

	// --- 1. preflight --------------------------------------------------------
	// `submit` is passed through so the report knows whether listing rules apply.
	const report = await preflight(directory, { owner, repo, category, description, submit });
	const errorCount = report.findings.filter((item) => item.level === 'error').length;
	steps.push(
		step(
			'preflight',
			report.ok ? 'ok' : 'failed',
			report.ok
				? `${String(report.findings.length)} note(s), no blocking problems`
				: `${String(errorCount)} blocking problem(s)`
		)
	);
	if (!report.ok) {
		return { ok: false, steps, report, published: null, pullRequest: null };
	}
	if (dryRun) {
		steps.push(step('dry-run', 'ok', 'stopped before making any change'));
		return { ok: true, steps, report, published: null, pullRequest: null };
	}

	// --- 2. the token --------------------------------------------------------
	let account;
	try {
		account = await verifyToken(token);
		steps.push(step('token', 'ok', `signed in as ${account.login}`));
	} catch (error) {
		steps.push(step('token', 'failed', scrubSecrets(String(error.message))));
		return { ok: false, steps, report, published: null, pullRequest: null };
	}

	// --- 3. the local repository --------------------------------------------
	let branch = 'main';
	try {
		if (!(await isRepository(subprocess, directory))) {
			await git(subprocess, ['init'], { cwd: directory, signal });
			// `-M` renames whatever the default branch was to main, so a machine
			// configured for `master` still produces a modern default.
			await git(subprocess, ['branch', '-M', 'main'], { cwd: directory, signal });
			steps.push(step('git-init', 'ok', 'initialised a new repository'));
		} else {
			branch = (await currentBranch(subprocess, directory)) ?? 'main';
			steps.push(step('git-init', 'ok', `already a repository on ${branch}`));
		}

		const identity = await readIdentity(subprocess, directory);
		if (identity.name.length === 0 || identity.email.length === 0) {
			// A commit needs an identity. Setting it locally (not globally) keeps the
			// change inside this repository, and using the GitHub account's own
			// noreply address keeps a private email out of the history.
			await git(subprocess, ['config', 'user.name', account.login], { cwd: directory, signal });
			await git(subprocess, ['config', 'user.email', `${account.login}@users.noreply.github.com`], { cwd: directory, signal });
			steps.push(step('git-identity', 'ok', `set a local commit identity for ${account.login}`));
		}

		// `-A` so deletions count too; a publish should mirror the directory.
		await git(subprocess, ['add', '-A'], { cwd: directory, signal });
		if (await hasChanges(subprocess, directory)) {
			await git(subprocess, ['commit', '-m', `chore: publish ${report.package.name} ${report.package.version}`], {
				cwd: directory,
				signal
			});
			steps.push(step('git-commit', 'ok', 'committed the working tree'));
		} else {
			steps.push(step('git-commit', 'ok', 'nothing new to commit'));
		}
	} catch (error) {
		const message = scrubSecrets(String(error.message));
		steps.push(step('git-local', 'failed', error.hint === undefined ? message : `${message} ${error.hint}`));
		return { ok: false, steps, report, published: null, pullRequest: null };
	}

	// --- 4. the GitHub repository -------------------------------------------
	const fullName = `${owner}/${repo}`;
	try {
		const existing = await getRepository(token, fullName);
		if (existing !== null) {
			steps.push(step('repo', 'ok', `${fullName} already exists`));
		} else {
			const created = await createRepository(token, {
				name: repo,
				description: description,
				private: isPrivate
			});
			steps.push(step('repo', 'ok', `created ${created.fullName}`));
		}
	} catch (error) {
		const message = scrubSecrets(String(error.message));
		steps.push(step('repo', 'failed', error.hint === undefined ? message : `${message} ${error.hint}`));
		return { ok: false, steps, report, published: null, pullRequest: null };
	}

	// --- 5. upload -----------------------------------------------------------
	//
	// Two transports, tried in order:
	//
	//   1. `git push` — the normal path. It preserves real git history and is
	//      faster for a large tree.
	//   2. the REST API — used when the git host is unreachable.
	//
	// The fallback is not a nicety. On the network this was built for,
	// `github.com:443` does not answer while `api.github.com` does, so `git push`
	// CANNOT succeed there and the API is the only way to publish at all.
	//
	// The token is embedded in the URL for this one command and then removed:
	// writing it into `.git/config` permanently would leave it readable on disk and
	// would carry it into any later fork.
	let transport = 'git';
	try {
		await setRemote(subprocess, directory, plainUrl(fullName));
		await git(subprocess, ['push', authenticatedUrl(token, fullName), `HEAD:refs/heads/${branch}`, '--force'], {
			cwd: directory,
			signal
		});
		// A fresh repository from the API has an `auto_init` commit, so the local
		// history and the remote one are unrelated; `--force` above replaces it.
		await git(subprocess, ['push', '--set-upstream', 'origin', branch, '--force'], { cwd: directory, signal });
		steps.push(step('push', 'ok', `pushed ${branch} to ${fullName} over git`));
	} catch (error) {
		if (!isConnectivityError(error)) {
			// A real failure (bad token, rejected push). The API would fail the same
			// way, and reporting a second error would hide the first one.
			const message = scrubSecrets(String(error.message));
			steps.push(step('push', 'failed', error.hint === undefined ? message : `${message} ${error.hint}`));
			return { ok: false, steps, report, published: { fullName, htmlUrl: `https://github.com/${fullName}` }, pullRequest: null };
		}

		// The git host is unreachable. Say so plainly, then upload over the API.
		steps.push(
			step('push', 'fallback', 'the git host is unreachable from here; uploading over the GitHub API instead')
		);
		transport = 'api';
		try {
			const uploaded = await uploadTree({
				token,
				owner,
				repo,
				branch,
				subprocess,
				directory,
				message: `chore: publish ${report.package.name} ${report.package.version}`
			});
			steps.push(
				step('upload', 'ok', `uploaded ${String(uploaded.fileCount)} file(s) as one commit over the API`)
			);
		} catch (uploadError) {
			const message = scrubSecrets(String(uploadError.message));
			steps.push(step('upload', 'failed', message));
			return { ok: false, steps, report, published: { fullName, htmlUrl: `https://github.com/${fullName}` }, pullRequest: null };
		}
	}

	const published = { fullName, htmlUrl: `https://github.com/${fullName}`, transport };

	// --- 6. topics -----------------------------------------------------------
	//
	// `dsh-plugin` is a hard requirement of the marketplace CI, and the API can set
	// it — so it is set here rather than left as a manual step. A failure is a
	// warning, never a failed publish: the code is already up, and the user can add
	// the topic by hand.
	let topics = [];
	try {
		topics = await setTopics(token, fullName, DEFAULT_TOPICS);
		published.topics = topics;
		steps.push(step('topics', 'ok', topics.join(', ')));
	} catch (error) {
		steps.push(
			step(
				'topics',
				'warn',
				`${scrubSecrets(String(error.message))}${error.hint === undefined ? '' : ` ${error.hint}`}`
			)
		);
	}

	// --- 7. the listing pull request ----------------------------------------
	if (!submit) {
		steps.push(step('submit', 'skipped', 'listing submission was not requested'));
		return { ok: true, steps, report, published, pullRequest: null };
	}

	try {
		// The submission always goes through the API, never a clone. A fork cannot
		// be cloned on a network that blocks `github.com`, and the API path is
		// additive by construction (`base_tree`), so there is no dirty-worktree
		// hazard to guard against either.
		const pullRequest = await openSubmissionPr({
			token,
			login: account.login,
			submission: report.submission,
			content: renderSubmissionYaml(report.submission),
			marketOwner: MARKET_OWNER,
			marketRepo: MARKET_REPO
		});
		steps.push(
			step(
				'submit',
				'ok',
				pullRequest.existing
					? `pull request #${String(pullRequest.number)} was already open`
					: `pull request #${String(pullRequest.number)} opened`
			)
		);
		return { ok: true, steps, report, published, pullRequest };
	} catch (error) {
		const message = scrubSecrets(String(error.message));
		steps.push(step('submit', 'failed', error.hint === undefined ? message : `${message} ${error.hint}`));
		return { ok: true, steps, report, published, pullRequest: null };
	}
}


/**
 * Read the current state of a plugin directory without changing anything.
 *
 * @param subprocess - the Host subprocess service.
 * @param directory - the plugin package root.
 * @param options - the intended destination, so the report matches what will be sent.
 * @returns the preflight report plus git facts.
 */
export async function inspect(subprocess, directory, options = {}) {
	const report = await preflight(directory, options);

	let git = { repository: false, branch: null, changes: false, identity: { name: '', email: '' } };
	try {
		git = {
			repository: await isRepository(subprocess, directory),
			branch: await currentBranch(subprocess, directory),
			changes: await hasChanges(subprocess, directory),
			identity: await readIdentity(subprocess, directory)
		};
	} catch {
		/* git may be unavailable; the report is still useful without it */
	}

	// Surface a missing commit identity as a warning, since the publisher sets one
	// locally when it is absent — the user should still know.
	if (git.repository && (git.identity.name.length === 0 || git.identity.email.length === 0)) {
		report.findings.push({
			level: 'warn',
			code: 'no-git-identity',
			message: 'git has no commit identity configured.',
			hint: 'The publisher sets one for this repository using your GitHub account.'
		});
	}

	return { ...report, git };
}

/**
 * Read the submission file if the plugin already carries one.
 *
 * @param directory - the plugin package root.
 * @returns the file contents, or null.
 */
export async function readExistingSubmission(directory) {
	try {
		return await readFile(join(directory, 'submission', 'awesome-dsh-plugin.yml'), 'utf8');
	} catch {
		return null;
	}
}
