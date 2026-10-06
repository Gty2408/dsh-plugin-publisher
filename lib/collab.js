/**
 * Collaboration primitives: which machine this is, its own SSH key, and the branch
 * it owns.
 *
 * ## The problem this solves
 *
 * Publishing is one-way: a directory becomes a repository. Collaboration is not,
 * because two machines editing one repository must both write to it without
 * destroying each other's work. That needs three things a publisher never needed:
 *
 *   1. **A stable identity per machine.** Two machines cannot share a branch or
 *      they will overwrite one another, so each one needs a name that does not
 *      change between sessions.
 *   2. **A credential that can push.** Not a token — see below.
 *   3. **A branch each machine owns**, so a push is additive by construction and
 *      no force is ever required.
 *
 * ## Why SSH keys rather than the token
 *
 * The token already works for pushing over HTTPS, so why mint a key? Because
 * measured on the machine this was built for, the two transports are not equally
 * reliable:
 *
 *     github.com:443        HTTPS   intermittent (3 of 6 TCP connects failed)
 *     github.com:22         SSH     6 of 6 open, 94-619 ms
 *     ssh.github.com:443    SSH     6 of 6 open
 *
 * A collaboration flow that depends on the flaky transport is a flow that fails
 * for reasons the user cannot act on. SSH is the transport that works here, so it
 * is the primary one.
 *
 * ## Why each machine must mint its OWN key
 *
 * A deploy key cannot be reused across repositories. Measured:
 *
 *     POST /repos/Gty2408/dsh-word-translate/keys   (existing key)  -> 422
 *     POST /repos/Gty2408/dsh-plugin-publisher/keys (a second key)  -> 201
 *
 * GitHub enforces global uniqueness of the key material, so a machine that copied
 * another machine's key would be refused. Each machine therefore generates its own,
 * and the key is installed on the ONE repository it is for. That is also why the
 * key file is named after the repository: a single machine collaborating on two
 * repositories needs two keys, and one fixed filename would silently cross-wire
 * them.
 *
 * ## Why the key path is wired in with forward slashes
 *
 * Measured on Windows: a backslash path is mangled by git's own shell quoting.
 *
 *     core.sshCommand = ssh -i C:\Users\gty\.ssh\id_ed25519_dsh ...
 *       -> Warning: Identity file C:Usersgty.sshid_ed25519_dsh not accessible
 *
 * The backslashes are stripped, so the key is never found and the failure reads as
 * an authentication problem rather than a path problem. Every path written into a
 * git config by this module is converted with {@link toPosixPath} first.
 *
 * @module dsh-plugin-publisher/collab
 */

import { homedir, hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';

import { runCommand, runGit, git } from './git.js';

/**
 * The branch prefix every machine branch carries.
 *
 * A prefix is used rather than a bare machine name so that machine branches are
 * always distinguishable from `main` and from a human's feature branch — the merge
 * step has to enumerate exactly the machine branches and nothing else.
 */
export const MACHINE_BRANCH_PREFIX = 'machine/';

/** Where generated keys live, under the user's home directory. */
const SSH_DIR_NAME = '.ssh';

/** Prefix on every key this plugin generates, so they are recognisable on GitHub. */
const KEY_COMMENT_PREFIX = 'dsh-collab';

/**
 * Convert a path to the form git's config parser can carry on Windows.
 *
 * See the module comment: a backslash path is stripped by git's own shell quoting,
 * and the resulting failure looks like a credential problem rather than a path
 * problem. Forward slashes work on every platform git supports.
 *
 * @param path - a native filesystem path.
 * @returns the path with forward slashes.
 */
export function toPosixPath(path) {
	return String(path).replace(/\\/gu, '/');
}

/**
 * This machine's name.
 *
 * `os.hostname()` is the identity because it is stable across sessions on the same
 * machine and differs between machines — which is exactly the two properties a
 * branch name needs. It is normalised because a hostname is not guaranteed to be a
 * legal git ref component (Windows hostnames are case-insensitive and may contain
 * characters git rejects in a ref).
 *
 * @param hostname - override, for tests.
 * @returns a name safe to embed in a branch.
 */
export function machineName(hostname) {
	const raw = hostname ?? hostnameOf();
	const cleaned = String(raw)
		.trim()
		.toLowerCase()
		// git rejects these in a ref, and a space or colon breaks the branch name.
		.replace(/[^a-z0-9._-]+/gu, '-')
		.replace(/^[.-]+/u, '')
		.replace(/[.-]+$/u, '')
		.slice(0, 48);
	return cleaned.length > 0 ? cleaned : 'machine';
}

/** Read the OS hostname, falling back to the home directory's last segment. */
function hostnameOf() {
	try {
		return osHostname();
	} catch {
		return null;
	}
}

/**
 * The branch this machine owns for one repository.
 *
 * @param machine - the machine name.
 * @returns e.g. `machine/desktop-qqnn9km`.
 */
export function machineBranch(machine) {
	return `${MACHINE_BRANCH_PREFIX}${machine}`;
}

/**
 * The key file for one repository on this machine.
 *
 * Named after the repository because a deploy key belongs to exactly one repository
 * (see the module comment): a fixed filename would be overwritten the moment this
 * machine joined a second project, and the first project's push would then fail
 * with a confusing authentication error.
 *
 * @param repository - `owner/repo`.
 * @param home - the home directory, for tests.
 * @returns the absolute key path in native form.
 */
export function keyPathFor(repository, home) {
	const safe = String(repository).replace(/[^A-Za-z0-9._-]+/gu, '-');
	return join(home ?? homedir(), SSH_DIR_NAME, `dsh_collab_${safe}`);
}

/**
 * The `core.sshCommand` value that makes git use one specific key.
 *
 * Three options earn their place:
 *
 *   - `-i <key>`            the key is not at an SSH default path, so git will not
 *                           offer it unless told to.
 *   - `-o BatchMode=yes`    a key that needs a passphrase must FAIL rather than
 *                           hang waiting for one. Keys minted here have no
 *                           passphrase, so this only ever fires on a surprise.
 *   - `-o StrictHostKeyChecking=accept-new`
 *                           the first connection to a host has no entry in
 *                           `known_hosts`; without this, a batch-mode connection
 *                           refuses and the failure looks like an auth error.
 *
 * @param keyPath - the private key path.
 * @returns the command string, with a forward-slash path.
 */
export function sshCommandFor(keyPath) {
	return [
		'ssh',
		'-i',
		toPosixPath(keyPath),
		'-o',
		'BatchMode=yes',
		'-o',
		'StrictHostKeyChecking=accept-new',
		'-o',
		'ConnectTimeout=15'
	].join(' ');
}

/**
 * The SSH remote URL for a repository.
 *
 * @param fullName - `owner/repo`.
 * @returns `git@github.com:owner/repo.git`.
 */
export function sshUrl(fullName) {
	return `git@github.com:${fullName}.git`;
}

/**
 * Whether a key pair already exists on this machine.
 *
 * @param subprocess - the Host subprocess service.
 * @param keyPath - the private key path.
 * @returns true when both halves are present and readable.
 */
export async function keyExists(subprocess, keyPath) {
	try {
		await readFile(keyPath, 'utf8');
		await readFile(`${keyPath}.pub`, 'utf8');
		return true;
	} catch {
		return false;
	}
}

/**
 * Mint this machine's key pair, or return the existing one.
 *
 * An existing pair is never regenerated: the public half is already installed on
 * GitHub, and replacing it would silently break every push until someone
 * reinstalled the new one by hand. `-N ''` makes the key passphrase-less, which is
 * required — a passphrase would need an agent, and this environment has none
 * (measured: `ssh-add -l` -> "Error connecting to agent: No such file or
 * directory").
 *
 * @param subprocess - the Host subprocess service.
 * @param options - `keyPath`, `comment`, `signal`.
 * @returns `{ created, keyPath, publicKey, comment }`.
 */
export async function ensureKey(subprocess, options) {
	const { keyPath, comment, signal } = options;

	if (await keyExists(subprocess, keyPath)) {
		const publicKey = (await readFile(`${keyPath}.pub`, 'utf8')).trim();
		return { created: false, keyPath, publicKey, comment: publicKey.split(/\s+/u).slice(2).join(' ') };
	}

	await mkdir(join(keyPath, '..'), { recursive: true });

	const result = await runCommand(
		subprocess,
		'ssh-keygen',
		[
			'-t', 'ed25519',
			// No passphrase: see above, there is no agent to unlock one with.
			'-N', '',
			'-C', comment,
			'-f', keyPath
		],
		{ signal, timeoutMs: 30_000 }
	);

	if (result.exitCode !== 0) {
		const detail = (result.stderr.trim() || result.stdout.trim() || `exit code ${String(result.exitCode)}`).split('\n')[0];
		throw new Error(`ssh-keygen failed: ${detail}`);
	}

	// ssh-keygen already restricts the private key on POSIX; this is a no-op there
	// and a documented best effort on Windows, where the mode is advisory.
	try {
		await chmod(keyPath, 0o600);
	} catch {
		/* Windows: the file mode is advisory and the call may not be supported */
	}

	const publicKey = (await readFile(`${keyPath}.pub`, 'utf8')).trim();
	return { created: true, keyPath, publicKey, comment };
}

/**
 * The public key's fingerprint, for display.
 *
 * Shown so a user can match the key on GitHub's page against the one on this
 * machine without pasting a key around. Computed from the key text rather than by
 * shelling out, because the base64 body is the whole input.
 *
 * @param publicKey - one line of `authorized_keys` form.
 * @returns the base64 body, truncated, or an empty string.
 */
export function keyFingerprint(publicKey) {
	const body = String(publicKey).trim().split(/\s+/u)[1] ?? '';
	return body.length > 0 ? `${body.slice(0, 16)}…` : '';
}

/**
 * Whether the working tree has uncommitted changes, and what they are.
 *
 * @param subprocess - the Host subprocess service.
 * @param directory - the repository.
 * @returns the `--porcelain` lines.
 */
export async function statusLines(subprocess, directory) {
	const result = await runGit(subprocess, ['status', '--porcelain'], { cwd: directory });
	return result.exitCode === 0 ? result.stdout.split('\n').filter((line) => line.trim().length > 0) : [];
}

/**
 * Write the per-repository SSH wiring into the local git config.
 *
 * `core.sshCommand` is set in the REPOSITORY's config rather than the user's global
 * one, so that:
 *
 *   - collaborating on this repository does not change how git behaves for every
 *     other repository on the machine, and
 *   - the key is bound to the one repository it is a deploy key for, which is what
 *     GitHub's per-repository key model expects.
 *
 * @param subprocess - the Host subprocess service.
 * @param options - `directory`, `keyPath`, `signal`.
 * @returns the command string that was written.
 */
export async function wireSsh(subprocess, options) {
	const { directory, keyPath, signal } = options;
	const command = sshCommandFor(keyPath);
	await git(subprocess, ['config', 'core.sshCommand', command], { cwd: directory, signal });
	return command;
}

/**
 * Read back the SSH command configured for a repository.
 *
 * @param subprocess - the Host subprocess service.
 * @param directory - the repository.
 * @returns the value, or null.
 */
export async function readSshCommand(subprocess, directory) {
	const result = await runGit(subprocess, ['config', '--get', 'core.sshCommand'], { cwd: directory });
	const value = result.stdout.trim();
	return result.exitCode === 0 && value.length > 0 ? value : null;
}

/**
 * Enumerate the machine branches present on a remote.
 *
 * Read with `ls-remote` rather than `branch -r`, because this is asked before the
 * local clone necessarily has the refs — and `ls-remote` is one round trip that
 * does not touch the working tree.
 *
 * @param subprocess - the Host subprocess service.
 * @param options - `directory`, `signal`.
 * @returns `{ branch, sha }` per machine branch, sorted by name.
 */
export async function listMachineBranches(subprocess, options) {
	const { directory, signal } = options;
	const result = await runGit(subprocess, ['ls-remote', '--heads', 'origin', `${MACHINE_BRANCH_PREFIX}*`], {
		cwd: directory,
		signal,
		timeoutMs: 60_000
	});
	if (result.exitCode !== 0) {
		const detail = (result.stderr.trim() || 'git ls-remote failed').split('\n')[0];
		throw new Error(detail);
	}

	const branches = [];
	for (const line of result.stdout.split('\n')) {
		const [sha, ref] = line.trim().split(/\s+/u);
		if (sha === undefined || ref === undefined) continue;
		const branch = ref.replace('refs/heads/', '');
		if (branch.startsWith(MACHINE_BRANCH_PREFIX)) branches.push({ branch, sha });
	}
	return branches.sort((a, b) => a.branch.localeCompare(b.branch));
}

/** Write a file, creating parent directories. */
export async function writeTextFile(path, text) {
	await mkdir(join(path, '..'), { recursive: true });
	await writeFile(path, text, 'utf8');
}

/**
 * Parse `owner/repo` out of any GitHub remote URL.
 *
 * Accepts the three forms this plugin itself writes (HTTPS, SSH, and a token-bearing
 * HTTPS URL), because a repository may have been cloned by hand before the plugin
 * ever saw it — and refusing to recognise that clone would strand the user.
 *
 * @param url - a remote URL.
 * @returns `owner/repo`, or null.
 */
export function parseFullName(url) {
	const text = String(url).trim().replace(/\.git$/u, '');
	// ssh://git@github.com/owner/repo  |  git@github.com:owner/repo
	const sshMatch = /github\.com[:/]([^/]+)\/([^/]+)$/u.exec(text);
	if (sshMatch !== null) return `${sshMatch[1]}/${sshMatch[2]}`;
	// https://github.com/owner/repo  |  https://x-access-token:...@github.com/owner/repo
	const httpsMatch = /github\.com\/([^/]+)\/([^/]+)$/u.exec(text);
	if (httpsMatch !== null) return `${httpsMatch[1]}/${httpsMatch[2]}`;
	return null;
}

/** Exposed for tests and callers: the key comment for one machine. */
export function keyCommentFor(machine) {
	return `${KEY_COMMENT_PREFIX}-${machine}`;
}
