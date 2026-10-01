/**
 * Host half of `dsh-plugin-publisher`.
 *
 * Publishes a DSH plugin to GitHub and submits it to the plugin marketplace,
 * driven from a settings page in the Web UI. Four loopback-only routes:
 *
 *   POST /inspect   read a plugin directory and return the preflight report
 *   POST /publish   run the whole flow
 *   POST /token     read or write the stored GitHub token
 *   POST /pick      ask the Host for a directory (native picker)
 *
 * ## Why the token lives in `ctx.credentials`
 *
 * A GitHub token is a secret with write access to every repository the account
 * can reach. `ctx.credentials` is the Host's own secret store: it keeps the value
 * out of the settings file, out of the browser, and out of every response — the
 * routes below can report `configured: true/false` without ever returning the
 * value. The plugin therefore never handles the token in the client half at all.
 *
 * ## Why no `@deepseek-ai/*` import
 *
 * The packages are not resolvable from a plugin in this deployment (verified:
 * `ERR_MODULE_NOT_FOUND` for `dsh-credentials`, `dsh-settings` and the rest). The
 * services are reached through `ctx` instead. That is also why `credentialRef`
 * is not imported: it only validates and brands a string, and `brandString` is
 * `return value`, so the brand is compile-time only — a plain string is accepted
 * by the live service.
 *
 * @module dsh-plugin-publisher
 */

import { preflight, renderSubmissionYaml, CATEGORIES } from './preflight.js';
import { publish, inspect } from './publish.js';
import { verifyToken } from './github.js';

/** Route paths, all under the plugin's own prefix. */
export const INSPECT_PATH = '/plugins/dsh-plugin-publisher/inspect';
export const PUBLISH_PATH = '/plugins/dsh-plugin-publisher/publish';
export const TOKEN_PATH = '/plugins/dsh-plugin-publisher/token';
export const PICK_PATH = '/plugins/dsh-plugin-publisher/pick';

/**
 * The credential reference holding the GitHub token.
 *
 * A POSIX shell identifier, matching the reference grammar the Host enforces.
 */
const TOKEN_REF = 'DSH_GITHUB_TOKEN';

/** Bound on a request body; a directory path and a description are small. */
const BODY_LIMIT_BYTES = 256 * 1024;

/** Read one JSON request body with a byte bound. */
async function readJsonBody(req, limitBytes = BODY_LIMIT_BYTES) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limitBytes) throw new Error('request body too large');
		chunks.push(chunk);
	}
	if (size === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Write one JSON response. */
function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(payload),
		'Cache-Control': 'no-store'
	});
	res.end(payload);
}

/**
 * Accept browser origins that are loopback only.
 *
 * These routes create repositories and hold a token, so they are refused to any
 * other origin. A request with no Origin header (a same-origin post, a local
 * tool) is allowed, mirroring the shipped plugin-route convention.
 */
function isLoopbackOrigin(req) {
	const origin = req.headers.origin;
	if (origin === undefined) return true;
	try {
		const { hostname } = new URL(origin);
		return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
	} catch {
		return false;
	}
}

/**
 * Read the stored token through the Host credential service.
 *
 * Resolution is per call, as the service requires: a token the user replaces in
 * settings reaches the next publish without a restart.
 *
 * @param ctx - plugin context.
 * @returns the token, or undefined when unconfigured.
 */
async function readToken(ctx) {
	const credentials = ctx.get('credentials');
	if (credentials === undefined) return undefined;
	try {
		const hit = await credentials.resolve(TOKEN_REF);
		return hit?.value;
	} catch {
		return undefined;
	}
}

/**
 * Whether a token is configured, without reading its value.
 *
 * `describe` is the UI-safe half of the service: it answers "is this set" and
 * "can I write it" and never returns the secret, which is what lets the settings
 * page show state without the value ever reaching the browser.
 *
 * @param ctx - plugin context.
 * @returns `{ available, configured, writable }`.
 */
async function describeToken(ctx) {
	const credentials = ctx.get('credentials');
	if (credentials === undefined) {
		return { available: false, configured: false, writable: false };
	}
	try {
		const info = await credentials.describe(TOKEN_REF);
		return { available: true, configured: info.configured === true, writable: info.writable === true };
	} catch {
		return { available: true, configured: false, writable: false };
	}
}

/**
 * Validate the submission fields out of an untrusted body.
 *
 * @param body - the parsed request body.
 * @returns the normalised options.
 */
function submissionOptions(body) {
	return {
		owner: typeof body.owner === 'string' ? body.owner.trim() : '',
		repo: typeof body.repo === 'string' ? body.repo.trim() : '',
		category: typeof body.category === 'string' ? body.category.trim() : '',
		description: typeof body.description === 'string' ? body.description.trim() : '',
		descriptionZh: typeof body.descriptionZh === 'string' ? body.descriptionZh.trim() : ''
	};
}

/**
 * Register every route on the Host web server.
 * @param ctx - context whose `webServer` serves the browser.
 */
function registerRoutes(ctx) {
	/** Shared gate: POST only, from this machine only. */
	const guard = (req, res) => {
		if (req.method !== 'POST') {
			sendJson(res, 405, { error: 'method not allowed' });
			return false;
		}
		if (!isLoopbackOrigin(req)) {
			sendJson(res, 403, { error: 'origin-not-trusted' });
			return false;
		}
		return true;
	};

	const readBody = async (req, res) => {
		try {
			return { body: await readJsonBody(req) };
		} catch (error) {
			sendJson(res, 400, { error: `invalid request body: ${String(error?.message ?? error)}` });
			return {};
		}
	};

	// --- token -----------------------------------------------------------------
	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: 'exact',
				path: TOKEN_PATH,
				handler: async (req, res) => {
					if (!guard(req, res)) return;
					const read = await readBody(req, res);
					if (read.body === undefined) return;
					const action = typeof read.body.action === 'string' ? read.body.action : 'status';

					if (action === 'status') {
						const state = await describeToken(ctx);
						sendJson(res, 200, {
							...state,
							// Named so the settings page can tell the user which
							// environment variable can also supply it.
							ref: TOKEN_REF
						});
						return;
					}

					const credentials = ctx.get('credentials');
					if (credentials === undefined) {
						sendJson(res, 500, { error: 'The host credential service is unavailable.' });
						return;
					}

					if (action === 'set') {
						const value = typeof read.body.value === 'string' ? read.body.value.trim() : '';
						if (value.length === 0) {
							sendJson(res, 400, { error: 'A token value is required.' });
							return;
						}
						try {
							// Verified before storing: a bad token saved silently would
							// fail much later, at the first push, with a vaguer message.
							const account = await verifyToken(value);
							await credentials.set(TOKEN_REF, value);
							sendJson(res, 200, { configured: true, login: account.login });
						} catch (error) {
							sendJson(res, 400, { error: String(error?.message ?? error) });
						}
						return;
					}

					if (action === 'clear') {
						try {
							await credentials.unset(TOKEN_REF);
							sendJson(res, 200, { configured: false });
						} catch (error) {
							sendJson(res, 500, { error: String(error?.message ?? error) });
						}
						return;
					}

					sendJson(res, 400, { error: `unknown action: ${action}` });
				}
			}),
		'dsh-plugin-publisher: token route'
	);

	// --- inspect ---------------------------------------------------------------
	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: 'exact',
				path: INSPECT_PATH,
				handler: async (req, res) => {
					if (!guard(req, res)) return;
					const read = await readBody(req, res);
					if (read.body === undefined) return;

					const directory = typeof read.body.directory === 'string' ? read.body.directory.trim() : '';
					if (directory.length === 0) {
						sendJson(res, 400, { error: 'A plugin directory is required.' });
						return;
					}

					const subprocess = ctx.get('subprocess');
					if (subprocess === undefined) {
						sendJson(res, 500, { error: 'The host subprocess service is unavailable.' });
						return;
					}

					try {
						const report = await inspect(subprocess, directory, submissionOptions(read.body));
						sendJson(res, 200, {
							...report,
							token: await describeToken(ctx),
							categories: CATEGORIES
						});
					} catch (error) {
						ctx.logger?.warn?.('dsh-plugin-publisher: inspect failed', error);
						sendJson(res, 500, { error: String(error?.message ?? error) });
					}
				}
			}),
		'dsh-plugin-publisher: inspect route'
	);

	// --- publish ---------------------------------------------------------------
	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: 'exact',
				path: PUBLISH_PATH,
				handler: async (req, res) => {
					if (!guard(req, res)) return;
					const read = await readBody(req, res);
					if (read.body === undefined) return;

					const directory = typeof read.body.directory === 'string' ? read.body.directory.trim() : '';
					if (directory.length === 0) {
						sendJson(res, 400, { error: 'A plugin directory is required.' });
						return;
					}

					// The token is checked BEFORE the subprocess service, because a missing
					// token is both the more likely problem and the one the user can fix
					// from the page. Reporting an unavailable host service instead would
					// send them looking in the wrong place.
					const token = await readToken(ctx);
					if (token === undefined) {
						sendJson(res, 400, {
							error: 'No GitHub token is configured.',
							hint: `Set one in this plugin's settings, or provide it as the ${TOKEN_REF} environment variable.`
						});
						return;
					}

					const subprocess = ctx.get('subprocess');
					if (subprocess === undefined) {
						sendJson(res, 500, { error: 'The host subprocess service is unavailable.' });
						return;
					}

					try {
						const result = await publish({
							subprocess,
							directory,
							token,
							...submissionOptions(read.body),
							submit: read.body.submit !== false,
							dryRun: read.body.dryRun === true,
							private: read.body.private === true
						});
						sendJson(res, result.ok ? 200 : 400, result);
					} catch (error) {
						// A throw here is unexpected; the flow reports its own failures.
						ctx.logger?.warn?.('dsh-plugin-publisher: publish threw', error);
						sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
					}
				}
			}),
		'dsh-plugin-publisher: publish route'
	);

	// --- directory picker ------------------------------------------------------
	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: 'exact',
				path: PICK_PATH,
				handler: async (req, res) => {
					if (!guard(req, res)) return;
					// The Host owns directory selection through its own controller;
					// the browser half calls that Remote API directly, so this route
					// only reports whether the capability exists at all.
					const picker = ctx.get('directoryPicker');
					sendJson(res, 200, {
						available: picker !== undefined,
						hint: picker === undefined ? 'Enter the path manually.' : undefined
					});
				}
			}),
		'dsh-plugin-publisher: pick route'
	);
}

/** Stable plugin name. */
export const name = 'dsh-plugin-publisher';

/**
 * No hard service dependency.
 *
 * `webServer` is attached through `ctx.inject`, so a deployment without a browser
 * registers nothing instead of holding a fiber that never activates.
 * `subprocess`, `credentials` and `directoryPicker` are probed with `ctx.get()`
 * at request time, so a missing one produces a clear error rather than a plugin
 * that refuses to load.
 */
export const inject = [];

/**
 * Install the Host half.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
	ctx.inject(['webServer'], (webCtx) => registerRoutes(webCtx));
}

export { preflight, renderSubmissionYaml };
