/**
 * Browser half of `dsh-plugin-publisher`.
 *
 * Adds one settings page — Settings → Plugins → Publish a plugin — where a plugin
 * author fills in the GitHub coordinates, sees the preflight report, and presses
 * Publish.
 *
 * ## Why a settings page rather than a chat surface
 *
 * Publishing is a deliberate, occasional action with a form-shaped input and a
 * long-running result. A settings page is the shell's own seat for that, it is
 * where every other plugin puts its configuration, and it keeps the action out of
 * the conversation. `dsh-market` already registers a `settings.section`, so a
 * third-party plugin doing the same is an established pattern rather than a
 * hijack of shipped UI.
 *
 * ## Why the token never reaches this half
 *
 * The token lives in the Host credential store and is written through the token
 * route. This half only ever learns `configured: true/false` — there is no code
 * path here that could read the secret, so a mistake in the UI cannot leak it.
 *
 * @module dsh-plugin-publisher/client
 */

window.__ModuleLoader__.load({
	id: 'dsh-plugin-publisher',
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		const React = require('react');

		/** Stable plugin identity; also the `data-plugin` marker the module system cleans up. */
		const PLUGIN_ID = 'dsh-plugin-publisher';
		/** Settings section id, and the cell key the shell addresses. */
		const SECTION_ID = 'dsh-plugin-publisher';
		/** Style-tag identity, used to inject the sheet exactly once per page. */
		const CSS_ID = 'dsh-plugin-publisher/client.css';

		const INSPECT_PATH = '/plugins/dsh-plugin-publisher/inspect';
		const PUBLISH_PATH = '/plugins/dsh-plugin-publisher/publish';
		const TOKEN_PATH = '/plugins/dsh-plugin-publisher/token';

		/** Where the form's non-secret values are remembered between visits. */
		const DRAFT_KEY = 'dsh-plugin-publisher.draft';

		const CSS = `
.dsh-pp-root {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 4px 2px 32px;
  max-width: 720px;
  color: var(--dsw-alias-label-primary, #1f2328);
  font-size: 14px;
}
.dsh-pp-card {
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  padding: 14px 16px;
}
.dsh-pp-card-title {
  font-size: 15px;
  font-weight: 600;
  margin: 0 0 10px;
}
.dsh-pp-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-bottom: 12px;
}
.dsh-pp-field:last-child {
  margin-bottom: 0;
}
.dsh-pp-label {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #6b7280);
}
.dsh-pp-input, .dsh-pp-select, .dsh-pp-textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.14));
  border-radius: 8px;
  background: var(--dsw-alias-bg-overlay, #ffffff);
  color: inherit;
  font: inherit;
  font-size: 13px;
}
.dsh-pp-textarea {
  min-height: 62px;
  resize: vertical;
}
.dsh-pp-input:focus, .dsh-pp-select:focus, .dsh-pp-textarea:focus {
  outline: 2px solid var(--dsw-alias-state-business-primary, #4561ee);
  outline-offset: -1px;
}
.dsh-pp-row {
  display: flex;
  gap: 10px;
  align-items: flex-end;
  flex-wrap: wrap;
}
.dsh-pp-row > .dsh-pp-field {
  flex: 1 1 200px;
  margin-bottom: 0;
}
.dsh-pp-button {
  padding: 8px 16px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.14));
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: inherit;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}
.dsh-pp-button:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
}
.dsh-pp-button:disabled {
  opacity: 0.5;
  cursor: default;
}
.dsh-pp-button-primary {
  border-color: transparent;
  background: var(--dsw-alias-state-business-primary, #4561ee);
  color: #ffffff;
  font-weight: 500;
}
.dsh-pp-button-primary:hover:not(:disabled) {
  background: var(--dsw-alias-state-business-primary, #4561ee);
  opacity: 0.9;
}
.dsh-pp-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.dsh-pp-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
.dsh-pp-dot-ok { background: var(--dsw-alias-state-success-primary, #12b76a); }
.dsh-pp-dot-warn { background: var(--dsw-alias-state-warning-primary, #f79009); }
.dsh-pp-dot-error { background: var(--dsw-alias-state-error-primary, #d92d20); }
.dsh-pp-findings {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
}
.dsh-pp-finding {
  display: flex;
  gap: 9px;
  align-items: flex-start;
  font-size: 13px;
  line-height: 1.55;
}
.dsh-pp-finding-body { min-width: 0; }
.dsh-pp-finding-hint {
  margin-top: 2px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #6b7280);
}
.dsh-pp-finding-error .dsh-pp-finding-message { color: var(--dsw-alias-state-error-primary, #d92d20); }
.dsh-pp-finding-warn .dsh-pp-finding-message { color: var(--dsw-alias-state-warning-primary, #b54708); }
.dsh-pp-steps {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}
.dsh-pp-step {
  display: flex;
  gap: 9px;
  align-items: baseline;
}
.dsh-pp-step-name {
  font-family: var(--ds-font-family-code, monospace);
  font-size: 12px;
  min-width: 96px;
  color: var(--dsw-alias-label-secondary, #6b7280);
}
.dsh-pp-note {
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary, #6b7280);
}
.dsh-pp-link {
  color: var(--dsw-alias-state-business-primary, #4561ee);
  text-decoration: none;
  word-break: break-all;
}
.dsh-pp-link:hover { text-decoration: underline; }
.dsh-pp-result-ok {
  border-color: var(--dsw-alias-state-success-primary, #12b76a);
}
.dsh-pp-code {
  font-family: var(--ds-font-family-code, monospace);
  font-size: 12px;
  background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.04));
  padding: 1px 5px;
  border-radius: 4px;
}
`;

		/** Inject the sheet once; the module system removes it on unload. */
		if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
			const styleTag = document.createElement('style');
			styleTag.dataset.plugin = PLUGIN_ID;
			styleTag.dataset.pluginCss = CSS_ID;
			styleTag.textContent = CSS;
			document.head.appendChild(styleTag);
		}

		/** POST one JSON request to a Host route and parse the reply. */
		async function postJson(path, payload) {
			const response = await fetch(path, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			let body = null;
			try {
				body = await response.json();
			} catch {
				/* a non-JSON answer falls back to the status code */
			}
			if (!response.ok) {
				const error = new Error(body?.error ?? `Request failed (HTTP ${String(response.status)})`);
				error.body = body;
				throw error;
			}
			return body;
		}

		/** Read the remembered form values. */
		function readDraft() {
			try {
				const raw = window.localStorage.getItem(DRAFT_KEY);
				return raw === null ? {} : JSON.parse(raw);
			} catch {
				return {};
			}
		}

		/** Remember the form values. The token is never part of these. */
		function storeDraft(draft) {
			try {
				window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
			} catch {
				/* an unwritable store just means the draft does not persist */
			}
		}

		/**
		 * The publish settings page.
		 *
		 * @param props - the settings section owner share (`close`).
		 */
		function PublisherSection(props) {
			void props;
			const draft = React.useRef(readDraft()).current;

			const [directory, setDirectory] = React.useState(draft.directory ?? '');
			const [owner, setOwner] = React.useState(draft.owner ?? '');
			const [repo, setRepo] = React.useState(draft.repo ?? '');
			const [category, setCategory] = React.useState(draft.category ?? 'ui');
			const [description, setDescription] = React.useState(draft.description ?? '');
			const [descriptionZh, setDescriptionZh] = React.useState(draft.descriptionZh ?? '');
			const [submit, setSubmit] = React.useState(draft.submit !== false);
			const [isPrivate, setIsPrivate] = React.useState(draft.private === true);

			const [tokenState, setTokenState] = React.useState(null);
			const [tokenInput, setTokenInput] = React.useState('');
			const [tokenBusy, setTokenBusy] = React.useState(false);
			const [tokenMessage, setTokenMessage] = React.useState('');

			const [report, setReport] = React.useState(null);
			const [inspectError, setInspectError] = React.useState('');
			const [busy, setBusy] = React.useState(false);
			const [result, setResult] = React.useState(null);

			/** Persist the non-secret fields whenever they change. */
			React.useEffect(() => {
				storeDraft({ directory, owner, repo, category, description, descriptionZh, submit, private: isPrivate });
			}, [directory, owner, repo, category, description, descriptionZh, submit, isPrivate]);

			/** Ask the Host which category values it accepts, and whether a token is set. */
			const loadTokenState = React.useCallback(async () => {
				try {
					const state = await postJson(TOKEN_PATH, { action: 'status' });
					setTokenState(state);
				} catch (error) {
					setTokenState({ available: false, configured: false, writable: false, error: String(error.message) });
				}
			}, []);

			React.useEffect(() => {
				void loadTokenState();
			}, [loadTokenState]);

			/** Run the preflight and show the report. */
			const runInspect = React.useCallback(async () => {
				if (directory.trim().length === 0) {
					setInspectError('Enter the plugin directory first.');
					setReport(null);
					return;
				}
				setBusy(true);
				setInspectError('');
				setResult(null);
				try {
					const next = await postJson(INSPECT_PATH, {
						directory,
						owner,
						repo,
						category,
						description,
						descriptionZh
					});
					setReport(next);
				} catch (error) {
					setInspectError(String(error.message));
					setReport(null);
				} finally {
					setBusy(false);
				}
			}, [directory, owner, repo, category, description, descriptionZh]);

			/** Save the token through the Host, which verifies it before storing. */
			const saveToken = React.useCallback(async () => {
				setTokenBusy(true);
				setTokenMessage('');
				try {
					const saved = await postJson(TOKEN_PATH, { action: 'set', value: tokenInput });
					setTokenInput('');
					setTokenMessage(`Verified and saved — signed in as ${String(saved.login ?? 'your account')}.`);
					await loadTokenState();
				} catch (error) {
					setTokenMessage(String(error.message));
				} finally {
					setTokenBusy(false);
				}
			}, [tokenInput, loadTokenState]);

			const clearToken = React.useCallback(async () => {
				setTokenBusy(true);
				setTokenMessage('');
				try {
					await postJson(TOKEN_PATH, { action: 'clear' });
					setTokenMessage('The stored token was removed.');
					await loadTokenState();
				} catch (error) {
					setTokenMessage(String(error.message));
				} finally {
					setTokenBusy(false);
				}
			}, [loadTokenState]);

			/** Run the whole publish flow. */
			const runPublish = React.useCallback(async () => {
				setBusy(true);
				setResult(null);
				try {
					const outcome = await postJson(PUBLISH_PATH, {
						directory,
						owner,
						repo,
						category,
						description,
						descriptionZh,
						submit,
						private: isPrivate
					});
					setResult(outcome);
				} catch (error) {
					// A failed publish answers with the step list, so it is shown the
					// same way a success is — the user needs to see how far it got.
					setResult(error.body ?? { ok: false, steps: [], error: String(error.message) });
				} finally {
					setBusy(false);
				}
			}, [directory, owner, repo, category, description, descriptionZh, submit, isPrivate]);

			const errors = (report?.findings ?? []).filter((item) => item.level === 'error');
			const warnings = (report?.findings ?? []).filter((item) => item.level === 'warn');
			const tokenReady = tokenState?.configured === true;
			const canPublish = report?.ok === true && tokenReady && !busy;

			const children = [];

			// --- the plugin directory -------------------------------------------
			children.push(
				React.createElement(
					'div',
					{ key: 'dir', className: 'dsh-pp-card' },
					React.createElement('h3', { className: 'dsh-pp-card-title' }, '1 · The plugin'),
					React.createElement(
						'div',
						{ className: 'dsh-pp-field' },
						React.createElement('span', { className: 'dsh-pp-label' }, 'Plugin directory (absolute path)'),
						React.createElement('input', {
							type: 'text',
							className: 'dsh-pp-input',
							value: directory,
							placeholder: 'C:\\\\Users\\\\you\\\\Documents\\\\my-plugin',
							onChange: (event) => setDirectory(event.target.value),
							spellCheck: false
						})
					),
					React.createElement(
						'div',
						{ className: 'dsh-pp-row' },
						React.createElement(
							'button',
							{ type: 'button', className: 'dsh-pp-button', onClick: () => void runInspect(), disabled: busy },
							'Check'
						),
						React.createElement(
							'label',
							{ className: 'dsh-pp-status', style: { cursor: 'pointer' } },
							React.createElement('input', {
								type: 'checkbox',
								checked: isPrivate,
								onChange: (event) => setIsPrivate(event.target.checked)
							}),
							'Create the repository as private'
						)
					)
				)
			);

			// --- the token ------------------------------------------------------
			const tokenBody = [];
			if (tokenState === null) {
				tokenBody.push(React.createElement('div', { key: 'loading', className: 'dsh-pp-note' }, 'Checking…'));
			} else if (tokenState.available !== true) {
				tokenBody.push(
					React.createElement(
						'div',
						{ key: 'unavailable', className: 'dsh-pp-note' },
						'The host credential service is unavailable, so a token cannot be stored. Provide it as the ',
						React.createElement('span', { className: 'dsh-pp-code' }, tokenState.ref ?? 'DSH_GITHUB_TOKEN'),
						' environment variable instead.'
					)
				);
			} else {
				tokenBody.push(
					React.createElement(
						'div',
						{ key: 'state', className: 'dsh-pp-status' },
						React.createElement('span', {
							className: tokenReady ? 'dsh-pp-dot dsh-pp-dot-ok' : 'dsh-pp-dot dsh-pp-dot-warn'
						}),
						tokenReady
							? 'A GitHub token is stored.'
							: 'No GitHub token yet. Create one at GitHub → Settings → Developer settings → Personal access tokens (classic) with the "repo" scope.'
					)
				);
				tokenBody.push(
					React.createElement(
						'div',
						{ key: 'input', className: 'dsh-pp-row', style: { marginTop: '10px' } },
						React.createElement(
							'div',
							{ className: 'dsh-pp-field' },
							React.createElement('span', { className: 'dsh-pp-label' }, 'Personal access token'),
							React.createElement('input', {
								type: 'password',
								className: 'dsh-pp-input',
								value: tokenInput,
								placeholder: tokenReady ? 'Replace the stored token' : 'ghp_…',
								onChange: (event) => setTokenInput(event.target.value),
								spellCheck: false,
								autoComplete: 'off'
							})
						),
						React.createElement(
							'button',
							{
								type: 'button',
								className: 'dsh-pp-button',
								onClick: () => void saveToken(),
								disabled: tokenBusy || tokenInput.trim().length === 0 || tokenState.writable === false
							},
							'Save token'
						),
						tokenReady
							? React.createElement(
								'button',
								{ type: 'button', className: 'dsh-pp-button', onClick: () => void clearToken(), disabled: tokenBusy },
								'Remove'
							)
							: null
					)
				);
				tokenBody.push(
					React.createElement(
						'div',
						{ key: 'note', className: 'dsh-pp-note', style: { marginTop: '8px' } },
						'The token is stored by the host credential service under ',
						React.createElement('span', { className: 'dsh-pp-code' }, tokenState.ref ?? 'DSH_GITHUB_TOKEN'),
						'. It is never sent to this page, and the page can only learn whether it is set.'
					)
				);
			}
			if (tokenMessage.length > 0) {
				tokenBody.push(
					React.createElement('div', { key: 'msg', className: 'dsh-pp-note', style: { marginTop: '8px' } }, tokenMessage)
				);
			}
			children.push(
				React.createElement(
					'div',
					{ key: 'token', className: 'dsh-pp-card' },
					React.createElement('h3', { className: 'dsh-pp-card-title' }, '2 · GitHub access'),
					tokenBody
				)
			);

			// --- the submission -------------------------------------------------
			const categories = report?.categories ?? [
				'agi', 'ui', 'usage', 'theme', 'model', 'identity', 'session', 'memory',
				'tools', 'wsl', 'browser', 'vision', 'voice', 'docs', 'skill', 'workflow',
				'git', 'notify', 'dev', 'security', 'remote', 'market', 'fun'
			];
			children.push(
				React.createElement(
					'div',
					{ key: 'listing', className: 'dsh-pp-card' },
					React.createElement('h3', { className: 'dsh-pp-card-title' }, '3 · The listing'),
					React.createElement(
						'div',
						{ className: 'dsh-pp-row' },
						React.createElement(
							'div',
							{ className: 'dsh-pp-field' },
							React.createElement('span', { className: 'dsh-pp-label' }, 'GitHub owner'),
							React.createElement('input', {
								type: 'text',
								className: 'dsh-pp-input',
								value: owner,
								placeholder: 'your-account',
								onChange: (event) => setOwner(event.target.value),
								spellCheck: false
							})
						),
						React.createElement(
							'div',
							{ className: 'dsh-pp-field' },
							React.createElement('span', { className: 'dsh-pp-label' }, 'Repository name'),
							React.createElement('input', {
								type: 'text',
								className: 'dsh-pp-input',
								value: repo,
								placeholder: 'my-dsh-plugin',
								onChange: (event) => setRepo(event.target.value),
								spellCheck: false
							})
						)
					),
					React.createElement(
						'div',
						{ className: 'dsh-pp-field', style: { marginTop: '12px' } },
						React.createElement('span', { className: 'dsh-pp-label' }, 'Category'),
						React.createElement(
							'select',
							{
								className: 'dsh-pp-select',
								value: category,
								onChange: (event) => setCategory(event.target.value)
							},
							categories.map((value) => React.createElement('option', { key: value, value }, value))
						)
					),
					React.createElement(
						'div',
						{ className: 'dsh-pp-field' },
						React.createElement(
							'span',
							{ className: 'dsh-pp-label' },
							'Description (English, one line, ends with a period — required)'
						),
						React.createElement('textarea', {
							className: 'dsh-pp-textarea',
							value: description,
							placeholder: 'Adds a sidebar panel that lists the files a session changed.',
							onChange: (event) => setDescription(event.target.value)
						})
					),
					React.createElement(
						'div',
						{ className: 'dsh-pp-field' },
						React.createElement('span', { className: 'dsh-pp-label' }, '中文描述（可选）'),
						React.createElement('textarea', {
							className: 'dsh-pp-textarea',
							value: descriptionZh,
							onChange: (event) => setDescriptionZh(event.target.value)
						})
					),
					React.createElement(
						'label',
						{ className: 'dsh-pp-status', style: { cursor: 'pointer' } },
						React.createElement('input', {
							type: 'checkbox',
							checked: submit,
							onChange: (event) => setSubmit(event.target.checked)
						}),
						'Also open the pull request to list it in the plugin marketplace'
					)
				)
			);

			// --- the preflight report -------------------------------------------
			if (inspectError.length > 0) {
				children.push(
					React.createElement(
						'div',
						{ key: 'inspect-error', className: 'dsh-pp-card' },
						React.createElement(
							'div',
							{ className: 'dsh-pp-status' },
							React.createElement('span', { className: 'dsh-pp-dot dsh-pp-dot-error' }),
							inspectError
						)
					)
				);
			}

			if (report !== null) {
				const rows = [];
				if (errors.length === 0 && warnings.length === 0) {
					rows.push(
						React.createElement(
							'div',
							{ key: 'clean', className: 'dsh-pp-status' },
							React.createElement('span', { className: 'dsh-pp-dot dsh-pp-dot-ok' }),
							'No problems found. This package meets the listing requirements.'
						)
					);
				}
				for (const [index, item] of report.findings.entries()) {
					rows.push(
						React.createElement(
							'div',
							{ key: `f-${String(index)}`, className: `dsh-pp-finding dsh-pp-finding-${item.level}` },
							React.createElement('span', {
								className: `dsh-pp-dot dsh-pp-dot-${item.level === 'error' ? 'error' : 'warn'}`
							}),
							React.createElement(
								'div',
								{ className: 'dsh-pp-finding-body' },
								React.createElement('div', { className: 'dsh-pp-finding-message' }, item.message),
								item.hint === undefined
									? null
									: React.createElement('div', { className: 'dsh-pp-finding-hint' }, item.hint)
							)
						)
					);
				}
				children.push(
					React.createElement(
						'div',
						{ key: 'report', className: 'dsh-pp-card' },
						React.createElement(
							'h3',
							{ className: 'dsh-pp-card-title' },
							`Check result — ${String(errors.length)} error(s), ${String(warnings.length)} warning(s)`
						),
						React.createElement('div', { className: 'dsh-pp-findings' }, rows)
					)
				);
			}

			// --- publish ---------------------------------------------------------
			const actions = [
				React.createElement(
					'button',
					{
						key: 'publish',
						type: 'button',
						className: 'dsh-pp-button dsh-pp-button-primary',
						onClick: () => void runPublish(),
						disabled: !canPublish
					},
					busy ? 'Publishing…' : 'Publish to GitHub'
				)
			];
			if (report !== null && !canPublish && !busy) {
				actions.push(
					React.createElement(
						'span',
						{ key: 'why', className: 'dsh-pp-note' },
						errors.length > 0
							? 'Fix the errors above first.'
							: tokenReady
								? 'Run the check first.'
								: 'Add a GitHub token first.'
					)
				);
			}
			children.push(
				React.createElement(
					'div',
					{ key: 'actions', className: 'dsh-pp-card' },
					React.createElement('h3', { className: 'dsh-pp-card-title' }, '4 · Publish'),
					React.createElement('div', { className: 'dsh-pp-row' }, actions)
				)
			);

			// --- the result -------------------------------------------------------
			if (result !== null) {
				const stepRows = (result.steps ?? []).map((item, index) =>
					React.createElement(
						'div',
						{ key: `s-${String(index)}`, className: 'dsh-pp-step' },
						React.createElement('span', {
							className: `dsh-pp-dot dsh-pp-dot-${item.status === 'ok' ? 'ok' : item.status === 'failed' ? 'error' : 'warn'}`
						}),
						React.createElement('span', { className: 'dsh-pp-step-name' }, item.name),
						React.createElement('span', null, item.detail ?? item.status)
					)
				);

				const links = [];
				if (result.published?.htmlUrl !== undefined) {
					links.push(
						React.createElement(
							'div',
							{ key: 'repo' },
							'Repository: ',
							React.createElement(
								'a',
								{ className: 'dsh-pp-link', href: result.published.htmlUrl, target: '_blank', rel: 'noreferrer' },
								result.published.htmlUrl
							)
						)
					);
				}
				if (result.pullRequest?.htmlUrl !== undefined) {
					links.push(
						React.createElement(
							'div',
							{ key: 'pr' },
							'Listing pull request: ',
							React.createElement(
								'a',
								{ className: 'dsh-pp-link', href: result.pullRequest.htmlUrl, target: '_blank', rel: 'noreferrer' },
								result.pullRequest.htmlUrl
							)
						)
					);
				}

				children.push(
					React.createElement(
						'div',
						{
							key: 'result',
							className: result.ok === true ? 'dsh-pp-card dsh-pp-result-ok' : 'dsh-pp-card'
						},
						React.createElement(
							'h3',
							{ className: 'dsh-pp-card-title' },
							result.ok === true ? 'Done' : 'Stopped'
						),
						React.createElement('div', { className: 'dsh-pp-steps' }, stepRows),
						links.length === 0
							? null
							: React.createElement('div', { className: 'dsh-pp-note', style: { marginTop: '10px' } }, links),
						result.ok === true && result.pullRequest === null && submit
							? React.createElement(
								'div',
								{ className: 'dsh-pp-note', style: { marginTop: '10px' } },
								'The plugin is published. The marketplace pull request did not go through — open it manually from the repository above.'
							)
							: null
					)
				);
			}

			return React.createElement('div', { className: 'dsh-pp-root' }, children);
		}

		/** Required client service: the slot registry this page renders through. */
		const inject = ['slots'];

		/**
		 * Register the settings page.
		 *
		 * Guarded so a slot-API change degrades to one console error instead of
		 * failing the plugin roster and raising the red boot banner.
		 *
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			try {
				ctx.slots.inject('settings.section', () =>
					ctx.slots.register(
						{
							name: 'settings.section',
							id: SECTION_ID,
							order: 60,
							label: () => '发布插件'
						},
						PublisherSection
					)
				);
			} catch (error) {
				console.error('[dsh-plugin-publisher] settings page failed to register:', error);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = 'dsh-plugin-publisher-client';
		return module.exports;
	}
});
