/**
 * GitHub REST calls for publishing a plugin.
 *
 * Only four operations are needed, and each one is a single request:
 *
 *   1. `GET /user`               — verify the token and learn the login
 *   2. `POST /user/repos`        — create the repository
 *   3. `POST /repos/:o/:r/forks` — fork the marketplace list
 *   4. `POST /repos/:o/:r/pulls` — open the listing pull request
 *
 * The file contents (the submission YAML) go through the git push rather than the
 * contents API, because the publisher already has a working tree — so there is one
 * write path, not two.
 *
 * `fetch` is used directly: it is available in the Host runtime, and the plugin
 * cannot import a client library anyway.
 *
 * @module dsh-plugin-publisher/github
 */

/** GitHub requires a User-Agent, and asks that it identify the tool. */
const USER_AGENT = 'dsh-plugin-publisher';

/** The curated list a plugin is submitted to. */
export const MARKET_OWNER = 'awesome-dsh-plugin';
export const MARKET_REPO = 'awesome-dsh-plugin';

/**
 * Call the GitHub API.
 *
 * Every failure carries GitHub's own `message` when it supplies one, because
 * "Validation Failed" alone is useless to a user; the `errors` array usually says
 * exactly which field was wrong.
 *
 * @param path - API path beginning with `/`.
 * @param options - `token`, `method`, `body`.
 * @returns the parsed JSON body, or null for a 204.
 * @throws an Error carrying `status` and GitHub's message.
 */
async function call(path, options) {
	const { token, method = 'GET', body } = options;
	const response = await fetch(`https://api.github.com${path}`, {
		method,
		headers: {
			Accept: 'application/vnd.github+json',
			Authorization: `Bearer ${token}`,
			'User-Agent': USER_AGENT,
			'X-GitHub-Api-Version': '2022-11-28',
			...(body === undefined ? {} : { 'Content-Type': 'application/json' })
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) })
	});

	if (response.status === 204) return null;

	let payload = null;
	try {
		payload = await response.json();
	} catch {
		/* a non-JSON body falls back to the status text below */
	}

	if (!response.ok) {
		const detail = Array.isArray(payload?.errors)
			? ` (${payload.errors.map((item) => item.message ?? item.field ?? String(item)).join('; ')})`
			: '';
		const error = new Error(`${payload?.message ?? response.statusText}${detail}`);
		error.status = response.status;
		error.githubErrors = payload?.errors;
		throw error;
	}
	return payload;
}

/**
 * Verify a token and return the account it belongs to.
 *
 * Called before anything is created, so a bad or under-scoped token fails while
 * nothing has been changed yet.
 *
 * @param token - a GitHub personal access token.
 * @returns `{ login, name, scopes }`.
 */
export async function verifyToken(token) {
	if (typeof token !== 'string' || token.trim().length === 0) {
		throw new Error('No GitHub token is configured.');
	}
	const user = await call('/user', { token });
	return { login: user.login, name: user.name ?? user.login };
}

/**
 * Create a repository for the signed-in account.
 *
 * A 422 means the name is taken, which is a normal thing for a user to hit and
 * deserves a clear sentence rather than GitHub's raw "Repository creation failed".
 *
 * @param token - a GitHub personal access token.
 * @param options - `name`, `description`, `private`.
 * @returns `{ fullName, htmlUrl, cloneUrl, defaultBranch }`.
 */
export async function createRepository(token, options) {
	const { name, description, private: isPrivate = false } = options;
	try {
		const repo = await call('/user/repos', {
			token,
			method: 'POST',
			body: {
				name,
				description: description ?? '',
				private: isPrivate,
				// A fresh repository with no commit has no branch to push onto, and
				// `auto_init` gives it one. It also makes the clone URL immediately
				// useful, which is what the push below relies on.
				auto_init: true
			}
		});
		return {
			fullName: repo.full_name,
			htmlUrl: repo.html_url,
			cloneUrl: repo.clone_url,
			defaultBranch: repo.default_branch ?? 'main'
		};
	} catch (error) {
		if (error.status === 422) {
			const taken = new Error(`The repository name "${name}" is already taken on your account.`);
			taken.status = 422;
			taken.hint = 'Choose a different name, or publish to the existing repository instead.';
			throw taken;
		}
		throw error;
	}
}

/**
 * Fork the marketplace list so a pull request can be opened from the user's copy.
 *
 * Forking is asynchronous on GitHub's side: the API returns as soon as the fork is
 * queued, and the git remote is not immediately available. The caller must poll
 * {@link getRepository} until it appears.
 *
 * @param token - a GitHub personal access token.
 * @returns `{ fullName, owner }`.
 */
export async function forkMarketplace(token) {
	const fork = await call(`/repos/${MARKET_OWNER}/${MARKET_REPO}/forks`, {
		token,
		method: 'POST',
		body: {}
	});
	return { fullName: fork.full_name, owner: fork.owner.login };
}

/**
 * Read one repository, or null when it does not exist yet.
 *
 * @param token - a GitHub personal access token.
 * @param fullName - `owner/repo`.
 * @returns the repository, or null on 404.
 */
export async function getRepository(token, fullName) {
	try {
		const repo = await call(`/repos/${fullName}`, { token });
		return { fullName: repo.full_name, defaultBranch: repo.default_branch ?? 'main', htmlUrl: repo.html_url };
	} catch (error) {
		if (error.status === 404) return null;
		throw error;
	}
}

/**
 * Wait for a fork to become available.
 *
 * Forking is queued, so an immediate clone fails with "repository not found" — a
 * confusing error that looks like a permissions problem. Polling turns it into a
 * short wait instead.
 *
 * @param token - a GitHub personal access token.
 * @param fullName - `owner/repo` of the fork.
 * @param options - `timeoutMs`, `intervalMs`.
 * @returns the repository once it exists.
 */
export async function waitForRepository(token, fullName, options = {}) {
	const timeoutMs = options.timeoutMs ?? 60_000;
	const intervalMs = options.intervalMs ?? 2_000;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const repo = await getRepository(token, fullName);
		if (repo !== null) return repo;
		if (Date.now() >= deadline) {
			throw new Error(`The fork ${fullName} did not appear within ${String(Math.round(timeoutMs / 1000))}s.`);
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

/**
 * Open a pull request.
 *
 * @param token - a GitHub personal access token.
 * @param options - `owner`, `repo`, `title`, `head`, `base`, `body`.
 * @returns `{ number, htmlUrl }`.
 */
export async function openPullRequest(token, options) {
	const { owner, repo, title, head, base, body } = options;
	try {
		const pr = await call(`/repos/${owner}/${repo}/pulls`, {
			token,
			method: 'POST',
			body: { title, head, base, body }
		});
		return { number: pr.number, htmlUrl: pr.html_url };
	} catch (error) {
		// 422 is GitHub's catch-all here: the branch may be identical to base (the
		// submission is already merged), or a PR may already be open.
		if (error.status === 422) {
			const conflict = new Error('GitHub refused the pull request.');
			conflict.status = 422;
			conflict.hint =
				'This usually means the submission is already in the list, or a pull request for it is already open.';
			throw conflict;
		}
		throw error;
	}
}

/**
 * Look for an existing open pull request from one branch.
 *
 * Used to make the operation idempotent: pressing publish twice should not open
 * two identical pull requests.
 *
 * @param token - a GitHub personal access token.
 * @param options - `owner`, `repo`, `head` (`user:branch`).
 * @returns the existing pull request, or null.
 */
export async function findOpenPullRequest(token, options) {
	const { owner, repo, head } = options;
	const list = await call(
		`/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(head)}`,
		{ token }
	);
	if (!Array.isArray(list) || list.length === 0) return null;
	return { number: list[0].number, htmlUrl: list[0].html_url };
}
