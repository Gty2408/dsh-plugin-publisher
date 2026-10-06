/**
 * Git operations, run through the Host's `ctx.subprocess` service.
 *
 * The plugin runs git rather than reimplementing it: a repository is a git
 * repository, and anything that tried to write `.git` by hand would break on the
 * first merge or packed ref. The subprocess service is used instead of
 * `node:child_process` because it is the Host's own seam — it resolves the
 * executable in the same execution world as the mounted filesystem, applies the
 * provider's environment scrubbing, and is torn down with the plugin.
 *
 * The environment passed to every call is copied from the Host's own git
 * integration, and each entry earns its place:
 *
 *   - `GIT_TERMINAL_PROMPT=0` — a push that needs credentials must FAIL, not hang
 *     waiting for a password on a machine with no terminal.
 *   - `GIT_CONFIG_COUNT=0` — drops ambient `GIT_CONFIG_KEY_n` overrides, which
 *     would otherwise let an unrelated environment variable redirect the remote.
 *   - `GIT_OPTIONAL_LOCKS=0` — avoids taking optional locks, which on Windows can
 *     collide with an editor holding the same repository.
 *   - `LC_ALL=C` — keeps git's output in one language so messages can be matched.
 *
 * @module dsh-plugin-publisher/git
 */

/** How long one git command may run before it is aborted. */
const COMMAND_TIMEOUT_MS = 120_000;

/** How long a git process is given to exit after termination is requested. */
const TERMINATE_GRACE_MS = 5_000;

/** Cap on collected output, so a huge diff cannot exhaust memory. */
const OUTPUT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Run one git command to completion.
 *
 * @param subprocess - the Host subprocess service.
 * @param args - git arguments; never shell-interpreted.
 * @param options - `cwd`, `env`, `stdin`, `signal`, `timeoutMs`.
 * @returns `{ exitCode, stdout, stderr, truncated }`.
 * @throws when git cannot be started, times out, or is aborted.
 */
export async function runGit(subprocess, args, options) {
	return runCommand(subprocess, 'git', args, options);
}

/**
 * Run one external command to completion.
 *
 * This is the general form of {@link runGit}, factored out so that `ssh-keygen`
 * — which the collaboration flow needs in order to mint this machine's own key —
 * goes through exactly the same seam: the Host resolves the executable, the same
 * environment scrubbing applies, and the same output caps hold. A second, parallel
 * spawn path would drift from this one, and the drift would show up as a hung
 * prompt on a machine with no terminal.
 *
 * @param subprocess - the Host subprocess service.
 * @param command - the executable to resolve and run.
 * @param args - arguments; never shell-interpreted.
 * @param options - `cwd`, `env`, `stdin`, `signal`, `timeoutMs`.
 * @returns `{ exitCode, stdout, stderr, truncated }`.
 * @throws when the command cannot be started, times out, or is aborted.
 */
export async function runCommand(subprocess, command, args, options) {
	const timeout = AbortSignal.timeout(options.timeoutMs ?? COMMAND_TIMEOUT_MS);
	const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);

	const executable = await subprocess.resolveExecutable(command);
	const handle = subprocess.spawn({
		argv: [executable, ...args],
		cwd: options.cwd,
		stdio: {
			stdin: options.stdin === undefined ? 'ignore' : { data: options.stdin },
			stdout: { maxBytes: OUTPUT_MAX_BYTES },
			stderr: { maxBytes: 64 * 1024 }
		},
		graceMs: TERMINATE_GRACE_MS,
		signal,
		env: {
			GIT_TERMINAL_PROMPT: '0',
			GIT_CONFIG_COUNT: '0',
			GIT_OPTIONAL_LOCKS: '0',
			LC_ALL: 'C',
			...options.env
		}
	});

	const outcome = await handle.done;
	if (timeout.aborted) {
		throw new Error(`${command} ${args.join(' ')} timed out after ${String(Math.round((options.timeoutMs ?? COMMAND_TIMEOUT_MS) / 1000))}s.`);
	}
	if (signal.aborted) {
		throw new Error(`${command} ${args.join(' ')} was cancelled.`);
	}

	const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false };
	const stderr = handle.collected.stderr?.readFrom(0)?.text ?? '';
	return { exitCode: outcome.exitCode, stdout: stdout.text, stderr, truncated: stdout.lossy === true };
}

/**
 * Run one git command and throw when it fails.
 *
 * The thrown message carries git's own stderr, because git's failures are usually
 * self-explanatory ("fatal: not a git repository") and wrapping them in a generic
 * sentence loses the only useful part.
 *
 * @param subprocess - the Host subprocess service.
 * @param args - git arguments.
 * @param options - as {@link runGit}.
 * @returns the command's stdout.
 */
export async function git(subprocess, args, options) {
	const result = await runGit(subprocess, args, options);
	if (result.exitCode !== 0) {
		const detail = (result.stderr.trim() || result.stdout.trim() || `exit code ${String(result.exitCode)}`).split('\n')[0];
		const error = new Error(`git ${args[0] ?? ''} failed: ${detail}`);
		error.exitCode = result.exitCode;
		error.stderr = result.stderr;
		error.hint = hintFor(args, result.stderr);
		throw error;
	}
	return result.stdout;
}

/**
 * Turn a git failure into an actionable sentence.
 *
 * This exists because git's own wording for the three failures a publisher is
 * most likely to hit does not say what to DO about them.
 *
 * @param args - the git arguments that failed.
 * @param stderr - git's stderr.
 * @returns a hint, or undefined when nothing specific is known.
 */
function hintFor(args, stderr) {
	const text = stderr.toLowerCase();
	if (text.includes('not a git repository')) {
		return 'Initialise the repository first (the publisher does this for you).';
	}
	if (text.includes('authentication failed') || text.includes('could not read username') || text.includes('403')) {
		return 'The GitHub token was rejected. It needs the "repo" scope (classic) or Contents: read and write (fine-grained).';
	}
	if (text.includes('nothing to commit')) {
		return 'There were no changes to commit; the repository already has this content.';
	}
	if (text.includes('already exists') && args[0] === 'remote') {
		return 'A remote named origin already exists; the publisher updates it instead of adding one.';
	}
	if (text.includes('repository not found')) {
		return 'The remote repository was not found. If it was just created or forked, GitHub may still be preparing it.';
	}
	return undefined;
}

/** Whether a directory is already a git repository. */
export async function isRepository(subprocess, directory) {
	const result = await runGit(subprocess, ['rev-parse', '--is-inside-work-tree'], { cwd: directory });
	return result.exitCode === 0 && result.stdout.trim() === 'true';
}

/** The current branch name, or null when HEAD is unborn. */
export async function currentBranch(subprocess, directory) {
	const result = await runGit(subprocess, ['branch', '--show-current'], { cwd: directory });
	const name = result.stdout.trim();
	return result.exitCode === 0 && name.length > 0 ? name : null;
}

/**
 * Whether the working tree has anything to commit.
 *
 * `--porcelain` is used rather than `status` because its output is stable and
 * machine-readable; an empty string means clean.
 */
export async function hasChanges(subprocess, directory) {
	const result = await runGit(subprocess, ['status', '--porcelain'], { cwd: directory });
	return result.exitCode === 0 && result.stdout.trim().length > 0;
}

/**
 * Point `origin` at a URL, replacing whatever it pointed at.
 *
 * `set-url` is tried first and `remote add` second, so this works whether or not
 * the remote already exists — and re-running a publish updates the remote rather
 * than failing on "already exists".
 */
export async function setRemote(subprocess, directory, url) {
	const existing = await runGit(subprocess, ['remote', 'get-url', 'origin'], { cwd: directory });
	if (existing.exitCode === 0) {
		await git(subprocess, ['remote', 'set-url', 'origin', url], { cwd: directory });
		return 'updated';
	}
	await git(subprocess, ['remote', 'add', 'origin', url], { cwd: directory });
	return 'added';
}

/**
 * Build an authenticated HTTPS remote URL.
 *
 * The token is embedded for the push and then removed from the remote, so it does
 * not persist in `.git/config` — a token written there would be readable by
 * anything that can read the file, and would be pushed into a fork by accident.
 *
 * @param token - a GitHub personal access token.
 * @param fullName - `owner/repo`.
 * @returns the URL.
 */
export function authenticatedUrl(token, fullName) {
	// `x-access-token` is GitHub's documented username for a token-authenticated
	// HTTPS push; the token itself is the password.
	return `https://x-access-token:${encodeURIComponent(token)}@github.com/${fullName}.git`;
}

/** The plain, credential-free URL for a repository. */
export function plainUrl(fullName) {
	return `https://github.com/${fullName}.git`;
}

/** Read the configured user identity, so the publisher can report a missing one. */
export async function readIdentity(subprocess, directory) {
	const name = await runGit(subprocess, ['config', '--get', 'user.name'], { cwd: directory });
	const email = await runGit(subprocess, ['config', '--get', 'user.email'], { cwd: directory });
	return {
		name: name.exitCode === 0 ? name.stdout.trim() : '',
		email: email.exitCode === 0 ? email.stdout.trim() : ''
	};
}
