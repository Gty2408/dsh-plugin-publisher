/**
 * Preflight validation for publishing a DSH plugin.
 *
 * This is the plugin's most valuable part, and it is worth being explicit about
 * why: the marketplace's own contributing guide names the single most common
 * rejection — a manifest that declares only `dsh.client`, which is NOT
 * installable. Every rule here comes from that guide, encoded so a publisher
 * finds the problem locally instead of in a maintainer's PR comment.
 *
 * Sources of the rules:
 *   https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md
 *
 * Nothing in this module touches the network or the filesystem's write side: it
 * reads a directory and returns a report. That keeps it testable without a host
 * and makes "check before publish" a safe, repeatable operation.
 *
 * @module dsh-plugin-publisher/preflight
 */

import { readFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
/**
 * Valid marketplace categories.
 *
 * `theme` is listed because it is a real category, but the guide routes it into
 * the market's dedicated Themes tab — so it is only correct for an actual theme.
 */
export const CATEGORIES = [
	'agi', 'ui', 'usage', 'theme', 'model', 'identity', 'session', 'memory',
	'tools', 'wsl', 'browser', 'vision', 'voice', 'docs', 'skill', 'workflow',
	'git', 'notify', 'dev', 'security', 'remote', 'market', 'fun',
];

/** GitHub's own owner/repo grammar, so a typo fails here rather than in CI. */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*$/u;
const REPO_RE = /^[A-Za-z0-9._-]+$/u;

/** One finding: a level, a machine-readable code, and a human sentence. */
function finding(level, code, message, hint) {
	return hint === undefined ? { level, code, message } : { level, code, message, hint };
}

/** Read and parse one JSON file, or report why it could not be read. */
async function readJson(path) {
	try {
		return { value: JSON.parse(await readFile(path, 'utf8')) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** Whether a path exists and is a file. */
async function isFile(path) {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

/**
 * The bundle id inside a browser half, if it has one.
 *
 * The loader matches this id against the package name, so a mismatch means the
 * browser half is never activated — and NOTHING reports an error. The plugin
 * looks installed and simply does nothing, which is the worst failure mode a
 * plugin can have and the reason this is checked.
 *
 * @param source - the client bundle source.
 * @returns the id, or undefined.
 */
export function bundleIdOf(source) {
	return /__ModuleLoader__\s*\.\s*load\s*\(\s*\{[\s\S]{0,300}?\bid\s*:\s*["']([^"']+)["']/u.exec(source)?.[1];
}

/**
 * The id of the first row a cordis patch inserts.
 *
 * Scoped to the insert list so an unrelated top-level `name:` cannot match.
 *
 * @param source - the patch YAML.
 * @returns the id, or undefined.
 */
export function patchRowIdOf(source) {
	const insert = /-\s*insert:([\s\S]*)/u.exec(source)?.[1] ?? source;
	return /^\s*-\s*id:\s*["']?([^\s"']+)["']?/mu.exec(insert)?.[1];
}

/**
 * File-name patterns that suggest a credential.
 *
 * These must never be published: a token in a public repository is compromised
 * the moment it is pushed, and a `.env` is the most common way one escapes.
 */
const SECRET_PATTERNS = [
	/^\.env(\..+)?$/u,
	/\.pem$/u,
	/\.key$/u,
	/^id_rsa/u,
	/^id_ed25519/u,
	/^\.npmrc$/u,
	/^\.netrc$/u,
	/credentials/iu,
	/secret/iu,
	/^\.github-token$/u
];

/**
 * Find files that look like they hold a credential.
 *
 * @param directory - the plugin root.
 * @param limit - how deep to walk; a plugin is shallow, and this bounds the work.
 * @returns paths relative to the root, forward-slashed.
 */
async function findCredentialFiles(directory, limit = 4) {
	const risky = [];
	async function walk(current, prefix, depth) {
		if (depth > limit) return;
		for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
			if (entry.name === 'node_modules' || entry.name === '.git') continue;
			const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) {
				await walk(join(current, entry.name), rel, depth + 1);
			} else if (SECRET_PATTERNS.some((pattern) => pattern.test(entry.name))) {
				risky.push(rel);
			}
		}
	}
	await walk(directory, '', 1);
	return risky;
}

/**
 * Validate one plugin directory against the marketplace requirements.
 *
 * @param directory - absolute path to the plugin package root.
 * @param options - `category` and `description` the user intends to submit, since
 *   those live in the submission rather than in the package.
 * @returns `{ ok, findings, package, submission }` — `ok` is true when there are
 *   no `error`-level findings. `warn` findings do not block publishing.
 */
export async function preflight(directory, options = {}) {
	const findings = [];

	// --- package.json --------------------------------------------------------
	const pkgPath = join(directory, 'package.json');
	if (!(await isFile(pkgPath))) {
		findings.push(
			finding('error', 'no-package-json', 'package.json is missing.', 'A DSH plugin package needs a package.json at its root.')
		);
		return { ok: false, findings, package: null, submission: null };
	}

	const parsed = await readJson(pkgPath);
	if (parsed.error !== undefined) {
		findings.push(
			finding('error', 'bad-package-json', `package.json is not valid JSON: ${parsed.error}`, 'Fix the syntax and retry.')
		);
		return { ok: false, findings, package: null, submission: null };
	}
	const pkg = parsed.value;

	// --- the installability manifest (the #1 rejection reason) ---------------
	const patchRef = pkg.dsh?.bundle?.patch;
	if (typeof patchRef !== 'string' || patchRef.length === 0) {
		findings.push(
			finding(
				'error',
				'no-bundle-manifest',
				'package.json does not declare dsh.bundle.patch.',
				'Without it the plugin is NOT installable, and this is the most common reason a submission is rejected. Add: "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }'
			)
		);
	} else {
		const patchPath = join(directory, patchRef.replace(/^\.\//u, ''));
		if (!(await isFile(patchPath))) {
			findings.push(
				finding('error', 'missing-patch-file', `dsh.bundle.patch points at ${patchRef}, which does not exist.`, 'Create the patch file next to package.json.')
			);
		} else {
			const patch = await readFile(patchPath, 'utf8');
			if (!patch.includes('- insert:')) {
				findings.push(
					finding('warn', 'patch-without-insert', `${patchRef} has no "- insert:" list.`, 'Most plugins register themselves with a top-level insert list.')
				);
			}
			if (typeof pkg.name === 'string') {
				// The row id is what the loader registers. A mismatch with the package
				// name means the module is never found — a silent no-load.
				const rowId = patchRowIdOf(patch);
				if (rowId === undefined) {
					findings.push(
						finding('warn', 'patch-without-id', `${patchRef} has no insert row with an id.`, 'The loader matches the insert row by id.')
					);
				} else if (rowId !== pkg.name) {
					findings.push(
						finding(
							'error',
							'patch-id-mismatch',
							`${patchRef} inserts the id "${rowId}" but the package is named "${pkg.name}".`,
							'The loader matches them, so the plugin will not load. Make them identical.'
						)
					);
				}
			}
		}
	}

	// --- the browser half's registration id ---------------------------------
	//
	// This is the check worth having most: when the client bundle registers an id
	// that differs from the package name, the browser half never activates and NOTHING
	// reports an error. The plugin looks installed and does nothing at all.
	if (pkg.dsh?.client !== undefined) {
		if (typeof pkg.dsh.client.platform !== 'string') {
			findings.push(
				finding('warn', 'client-without-platform', 'dsh.client is declared without a platform.', 'Set dsh.client.platform, usually "web".')
			);
		}

		// The client half can be named by exports["./client"], dsh.client.entry, or
		// the conventional path.
		const candidates = [pkg.exports?.['./client'], pkg.dsh.client.entry, './lib/client.js'].filter(
			(value) => typeof value === 'string'
		);
		let clientPath;
		for (const candidate of candidates) {
			const full = join(directory, candidate.replace(/^\.\//u, ''));
			if (await isFile(full)) {
				clientPath = full;
				break;
			}
		}

		if (clientPath === undefined) {
			findings.push(
				finding(
					'error',
					'missing-client-bundle',
					'dsh.client is declared but no browser bundle was found.',
					`Looked at exports["./client"], dsh.client.entry and ./lib/client.js.`
				)
			);
		} else {
			const source = await readFile(clientPath, 'utf8');
			const id = bundleIdOf(source);
			if (id === undefined) {
				findings.push(
					finding(
						'error',
						'no-bundle-id',
						`${clientPath.slice(directory.length + 1)} has no __ModuleLoader__.load({ id }) registration.`,
						'Without it the browser half is never served.'
					)
				);
			} else if (typeof pkg.name === 'string' && id !== pkg.name) {
				findings.push(
					finding(
						'error',
						'bundle-id-mismatch',
						`The browser bundle registers the id "${id}" but the package is named "${pkg.name}".`,
						'The loader matches them, so the browser half will NEVER load — and nothing reports an error. Make them identical.'
					)
				);
			}
		}
	}

	// --- identity and metadata ----------------------------------------------
	if (typeof pkg.name !== 'string' || pkg.name.length === 0) {
		findings.push(finding('error', 'no-name', 'package.json has no name.', 'npm requires a package name.'));
	} else if (pkg.name !== pkg.name.toLowerCase()) {
		findings.push(
			finding('error', 'uppercase-name', `The package name "${pkg.name}" has uppercase letters.`, 'npm rejects new packages with uppercase names; use lowercase.')
		);
	}

	if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+/u.test(pkg.version)) {
		findings.push(finding('error', 'bad-version', `The version "${String(pkg.version)}" is not a semver string.`, 'Use MAJOR.MINOR.PATCH.'));
	}

	if (typeof pkg.license !== 'string' || pkg.license.length === 0) {
		findings.push(finding('warn', 'no-license', 'package.json declares no license.', 'npm warns on publish, and the marketplace prefers a stated license.'));
	} else if (!(await isFile(join(directory, 'LICENSE'))) && !(await isFile(join(directory, 'LICENSE.md')))) {
		findings.push(
			finding('warn', 'no-license-file', `The license is "${pkg.license}" but no LICENSE file ships.`, 'Add a LICENSE file so the terms travel with the code.')
		);
	}

	// The guide requires the `dsh-plugin` TOPIC on the repository. That is a
	// repository setting, not a manifest field, and the publisher sets it over the
	// API — so a missing keyword is only a discovery hint, never a blocker. Treating
	// it as an error would reject plugins that are perfectly listable.
	if (!Array.isArray(pkg.keywords) || !pkg.keywords.includes('dsh-plugin')) {
		findings.push(
			finding(
				'warn',
				'no-topic-keyword',
				'keywords does not include "dsh-plugin".',
				'The required dsh-plugin TOPIC is set on the repository automatically; this keyword only helps npm search.'
			)
		);
	}

	if (typeof pkg.repository?.url !== 'string' || pkg.repository.url.includes('OWNER/REPO')) {
		findings.push(
			finding('warn', 'no-repository', 'package.json has no usable repository field.', 'It links the npm package to the repo; the publisher fills it in for you.')
		);
	}

	// --- real, working code --------------------------------------------------
	if (!(await isFile(join(directory, 'README.md')))) {
		findings.push(finding('warn', 'no-readme', 'No README.md.', 'The marketplace reads it for screenshots and the detail page.'));
	}

	const entry = typeof pkg.main === 'string' ? pkg.main : 'lib/index.js';
	if (!(await isFile(join(directory, entry.replace(/^\.\//u, ''))))) {
		findings.push(
			finding('error', 'missing-entry', `The entry file "${entry}" does not exist.`, 'A placeholder or README-only repository does not qualify for listing.')
		);
	}

	// --- the destination ------------------------------------------------------
	//
	// `owner` and `repo` are always needed: they are where the code goes. The rest
	// belongs to the marketplace listing, and is only required when a listing is
	// actually being submitted. Publishing for personal use must not be blocked by
	// rules about how a catalogue entry reads.
	const owner = typeof options.owner === 'string' ? options.owner.trim() : '';
	const repo = typeof options.repo === 'string' ? options.repo.trim() : '';
	const category = typeof options.category === 'string' ? options.category.trim() : '';
	const description = typeof options.description === 'string' ? options.description.trim() : '';
	const submitting = options.submit !== false;

	if (owner.length === 0 || !OWNER_RE.test(owner)) {
		findings.push(finding('error', 'bad-owner', `The GitHub owner "${owner}" is not a valid account name.`));
	}
	if (repo.length === 0 || !REPO_RE.test(repo)) {
		findings.push(finding('error', 'bad-repo', `The repository name "${repo}" is not valid.`, 'Letters, digits, dot, dash and underscore only.'));
	}

	if (!submitting) {
		// Personal use: the repository description is nice to have, nothing more.
		if (description.length === 0) {
			findings.push(
				finding('warn', 'no-description', 'No description was given.', 'The GitHub repository will have an empty description.')
			);
		}
	} else {
		if (category.length === 0 || !CATEGORIES.includes(category)) {
			findings.push(
				finding('error', 'bad-category', `The category "${category}" is not one of the accepted values.`, `Pick one of: ${CATEGORIES.join(', ')}`)
			);
		}
		if (category === 'theme') {
			findings.push(
				finding('warn', 'theme-category', 'The theme category is routed to the market\'s Themes tab.', 'Only choose it if this really is a theme or skin.')
			);
		}
		if (description.length === 0) {
			findings.push(finding('error', 'no-description', 'No English description was given.', 'Only description.en is required by the guide.'));
		} else {
			if (!description.endsWith('.')) {
				findings.push(finding('error', 'description-no-period', 'The description does not end with a period.', 'The guide requires a one-line description ending with a period.'));
			}
			if (/\b(amazing|awesome|best|revolutionary|powerful|ultimate|seamless|blazing)\b/iu.test(description)) {
				findings.push(
					finding('warn', 'description-marketing', 'The description contains a marketing word.', 'The guide requires a plain statement of what the plugin does.')
				);
			}
		}
		// A description claiming a count is checked against the code by reviewers.
		const claimed = /\b(\d+)\s+(tools?|commands?|providers?)\b/iu.exec(description);
		if (claimed !== null) {
			findings.push(
				finding(
					'warn',
					'description-claim',
					`The description claims a specific count ("${claimed[0]}").`,
					'Reviewers verify counts against the source, so make sure the number is exact.'
				)
			);
		}
	}

	// --- hygiene -------------------------------------------------------------
	if (await isFile(join(directory, '.gitignore'))) {
		// Nothing to say; its presence is good.
	} else {
		findings.push(finding('warn', 'no-gitignore', 'No .gitignore.', 'Build output and large data files are easy to commit by accident.'));
	}

	// --- credentials must never be published ---------------------------------
	//
	// A token in a public repository is compromised the moment it is pushed, and a
	// `.env` is the most common way one escapes. This is an error rather than a
	// warning: publishing is irreversible in the sense that matters — the secret is
	// already public even if the commit is deleted afterwards.
	const credentialFiles = await findCredentialFiles(directory);
	if (credentialFiles.length > 0) {
		findings.push(
			finding(
				'error',
				'credential-files',
				`These files look like credentials and must not be published: ${credentialFiles.join(', ')}.`,
				'Delete them, or add them to .gitignore, then retry. A secret pushed to a public repository is already compromised.'
			)
		);
	}

	// A very large committed file makes the repository painful to clone.
	const bulky = [];
	for (const name of await readdir(directory).catch(() => [])) {
		const path = join(directory, name);
		const info = await stat(path).catch(() => null);
		if (info?.isFile() === true && info.size > 5 * 1024 * 1024) {
			bulky.push(`${name} (${(info.size / 1024 / 1024).toFixed(1)} MB)`);
		}
	}
	if (bulky.length > 0) {
		findings.push(
			finding('warn', 'bulky-files', `Large files at the package root: ${bulky.join(', ')}.`, 'Consider shipping them via a release asset, or excluding them.')
		);
	}

	const submission = {
		url: `https://github.com/${owner}/${repo}`,
		name: `${owner}/${repo}`,
		category,
		description: { en: description },
		fileName: `${owner}__${repo}.yml`,
	};

	return {
		ok: !findings.some((item) => item.level === 'error'),
		findings,
		package: { name: pkg.name, version: pkg.version, entry },
		submission,
	};
}

/**
 * Serialise a submission as the YAML the marketplace expects.
 *
 * Written by hand rather than with a YAML library because the plugin cannot
 * import one (no `@deepseek-ai/*`, and adding a runtime dependency would force a
 * build approval on every install for four lines of output). Values are quoted
 * so a description containing ": " cannot be parsed as a nested key — the exact
 * trap the contributing guide calls out.
 *
 * @param submission - the object returned by {@link preflight}.
 * @returns the file contents.
 */
export function renderSubmissionYaml(submission) {
	const quote = (value) => `'${String(value).replace(/'/gu, "''")}'`;
	const lines = [
		`url: ${submission.url}`,
		`name: ${submission.name}`,
		`category: ${submission.category}`,
		'description:',
		`  en: ${quote(submission.description.en)}`,
	];
	if (typeof submission.description.zh === 'string' && submission.description.zh.length > 0) {
		lines.push(`  zh: ${quote(submission.description.zh)}`);
	}
	return `${lines.join('\n')}\n`;
}
