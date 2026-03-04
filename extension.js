const vscode = require('vscode');
const path = require('path');
const { execFile } = require('child_process');

let outputChannel;
let historySnapshotStore;
const LOG_RECORD_SEPARATOR = '\x1e';
const LOG_FIELD_SEPARATOR = '\x1f';
const HISTORY_SCHEME = 'calgit-history';

/**
 * @param {unknown} value
 */
function serializeForLog(value) {
	if (value instanceof Error) {
		return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
	}
	if (typeof value === 'string') {
		return value;
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/**
 * @param {string} message
 * @param {...unknown} data
 */
function log(message, ...data) {
	const timestamp = new Date().toISOString();
	const suffix = data.length > 0 ? ` ${data.map(serializeForLog).join(' ')}` : '';
	const line = `[${timestamp}] ${message}${suffix}`;
	console.log(line);
	outputChannel?.appendLine(line);
}

/**
 * @param {string} childPath
 * @param {string} parentPath
 */
function isSameOrChildPath(childPath, parentPath) {
	const relative = path.relative(parentPath, childPath);
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * @param {string} raw
 * @param {string} fileUri
 */
function parseGitLogOutput(raw, fileUri) {
	return raw
		.split(LOG_RECORD_SEPARATOR)
		.map(entry => entry.trim())
		.filter(Boolean)
		.map(entry => {
			const [hash, date, author, message] = entry.split(LOG_FIELD_SEPARATOR);
			return { hash, date, author, message, fileUri };
		})
		.filter(commit => commit.hash && commit.date);
}

/**
 * @param {vscode.TextEditor | undefined} editor
 */
function enforceHistoryEditorReadOnly(editor) {
	if (!editor || editor.document.uri.scheme !== HISTORY_SCHEME) {
		return;
	}
	if (editor.options.readOnly) {
		return;
	}
	editor.options = { ...editor.options, readOnly: true };
}

/**
 * @param {readonly vscode.TextEditor[]} editors
 */
function enforceHistoryEditorsReadOnly(editors) {
	(editors || []).forEach(enforceHistoryEditorReadOnly);
}

class HistorySnapshotStore {
	constructor() {
		this._entries = new Map();
	}

	/**
	 * @param {string} relPath
	 * @param {string} hash
	 */
	createUri(relPath, hash) {
		const normalizedRelPath = relPath.startsWith('/') ? relPath : `/${relPath}`;
		const hashParam = encodeURIComponent(hash);
		const sourceParam = encodeURIComponent(relPath);
		return vscode.Uri.from({
			scheme: HISTORY_SCHEME,
			path: normalizedRelPath,
			query: `hash=${hashParam}&src=${sourceParam}&t=${Date.now().toString(36)}`
		});
	}

	/**
	 * @param {vscode.Uri} uri
	 * @param {string} content
	 */
	store(uri, content) {
		this._entries.set(uri.toString(), content);
	}

	/**
	 * @param {vscode.Uri} uri
	 */
	delete(uri) {
		this._entries.delete(uri.toString());
	}

	/**
	 * @param {vscode.Uri} uri
	 */
	provideTextDocumentContent(uri) {
		return this._entries.get(uri.toString()) || 'Snapshot unavailable. Reopen it from the Calgit view.';
	}
}

class CalendarViewProvider {
	static viewType = 'calgit.calendarView';

	/** @param {vscode.ExtensionContext} context */
	constructor(context) {
		this._context = context;
		this._webviewView = null;
		log('CalendarViewProvider: created', { extensionPath: context.extensionPath });
	}

	/**
	 * @param {string} message
	 * @param {'info' | 'error'} level
	 */
	postWebviewStatus(message, level = 'info') {
		this._webviewView?.webview.postMessage({ command: 'status', message, level });
	}

	/**
	 * @param {vscode.WebviewView} webviewView
	 */
	resolveWebviewView(webviewView) {
		log('resolveWebviewView: called', { viewType: CalendarViewProvider.viewType });
		this._webviewView = webviewView;
		webviewView.webview.options = {
			enableScripts: true
		};

		webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);
		log('resolveWebviewView: html assigned');
		this.postWebviewStatus('Open a file to load commit history.');

		webviewView.webview.onDidReceiveMessage(async message => {
			log('webview message received', message);
			try {
				switch (message.command) {
					case 'requestCommits':
						await this.provideCommits(message.fileUri);
						break;
					case 'requestActiveFile':
						this.sendActiveFileToWebview();
						break;
					case 'openCommit':
						await this.openCommit(message.hash, message.fileUri);
						break;
					case 'openDiffWithCurrent':
						await this.openDiffWithCurrent(message.hash, message.fileUri);
						break;
					case 'openDiffWithPrevious':
						await this.openDiffWithPrevious(message.hash, message.fileUri);
						break;
					case 'openDiffBetweenCommits':
						await this.openDiffBetweenCommits(message.leftHash, message.rightHash, message.fileUri);
						break;
					default:
						log('webview message ignored: unknown command', message.command);
				}
			} catch (error) {
				log('webview message handler failed', error);
				const errorMessage = `Calgit error: ${error instanceof Error ? error.message : String(error)}`;
				this.postWebviewStatus(errorMessage, 'error');
				vscode.window.showErrorMessage(errorMessage);
			}
		});
		webviewView.onDidDispose(() => {
			log('resolveWebviewView: webview disposed');
		});

			// send initial file (active editor)
			this.sendActiveFileToWebview();
		}

	sendActiveFileToWebview() {
		const editor = vscode.window.activeTextEditor;
		if (editor && editor.document.uri.scheme === 'file') {
			const fileUri = editor.document.uri.toString();
			log('sendActiveFileToWebview: posting active file', fileUri);
			this._webviewView?.webview.postMessage({ command: 'setFile', fileUri });
			return;
		}
		log('sendActiveFileToWebview: no active file editor found');
		this.postWebviewStatus('No active file selected.', 'error');
	}

	async provideCommits(fileUri) {
		log('provideCommits: start', fileUri);
		if (!fileUri) {
			this.postWebviewStatus('No file selected.');
			this._webviewView?.webview.postMessage({ command: 'commits', commits: [] });
			return;
		}
		const uri = vscode.Uri.parse(fileUri);
		if (uri.scheme !== 'file') {
			this.postWebviewStatus(`Unsupported URI scheme: ${uri.scheme}`, 'error');
			this._webviewView?.webview.postMessage({ command: 'commits', commits: [] });
			return;
		}
		const repoRoot = await this.getRepositoryRootForUri(uri);
		if (!repoRoot) {
			log('provideCommits: no matching repository', { fileUri });
			this.postWebviewStatus('No Git repository found for this file. Open the repository root or enable Git parent repository discovery.');
			this._webviewView?.webview.postMessage({ command: 'commits', commits: [] });
			return;
		}
		const relPath = path.relative(repoRoot, uri.fsPath).replace(/\\/g, '/');
		if (relPath.startsWith('..')) {
			log('provideCommits: file is outside repository root', { repoRoot, filePath: uri.fsPath });
			this.postWebviewStatus('The active file is outside the detected repository root.');
			this._webviewView?.webview.postMessage({ command: 'commits', commits: [] });
			return;
		}
		this.postWebviewStatus(`Loading commits for ${relPath}...`);
			const commitLogRaw = await this.execGit(repoRoot, [
				'log',
				'--follow',
				'--date=iso-strict',
				`--pretty=format:%H%x1f%aI%x1f%an <%ae>%x1f%s%x1e`,
				'--',
				relPath
			]);
		const commits = parseGitLogOutput(commitLogRaw, fileUri);
		log('provideCommits: commits resolved', { relPath, commitCount: commits.length });
		this._webviewView?.webview.postMessage({ command: 'commits', commits });
		if (commits.length === 0) {
			this.postWebviewStatus('No commits found for this file in the current branch.');
		} else {
			this.postWebviewStatus(`Loaded ${commits.length} commit(s) for ${relPath}.`);
		}
	}

	async getRepositoryRootForUri(uri) {
		const gitExt = vscode.extensions.getExtension('vscode.git');
		if (!gitExt) {
			log('getRepositoryRootForUri: vscode.git extension not found, trying git cli fallback');
		} else {
			if (!gitExt.isActive) {
				log('getRepositoryRootForUri: activating vscode.git extension');
				await gitExt.activate();
			}
			const api = gitExt.exports?.getAPI?.(1);
			if (api) {
				const repositories = api.repositories || [];
				log('getRepositoryRootForUri: available repositories', repositories.map(r => r.rootUri.fsPath));
				const matches = repositories
					.filter(r => isSameOrChildPath(uri.fsPath, r.rootUri.fsPath))
					.sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length);
				const selected = matches[0] || null;
				log('getRepositoryRootForUri: selected repository from API', selected ? selected.rootUri.fsPath : null);
				if (selected) {
					return selected.rootUri.fsPath;
				}
			} else {
				log('getRepositoryRootForUri: git API unavailable after activation');
			}
		}

		try {
			const root = (await this.execGit(path.dirname(uri.fsPath), ['rev-parse', '--show-toplevel'])).trim();
			log('getRepositoryRootForUri: selected repository from git cli', root || null);
			return root || null;
		} catch (error) {
			log('getRepositoryRootForUri: git cli fallback failed', error);
			return null;
		}
	}

	async openCommit(hash, fileUri) {
		log('openCommit: start', { hash, fileUri });
		const { uri, repoRoot, relPath } = await this.resolveFileContext(fileUri);
		const content = await this.getCommitFileContent(repoRoot, hash, relPath);
		const languageId = await this.getLanguageIdForUri(uri);
		let doc;

		if (historySnapshotStore) {
			const snapshotUri = historySnapshotStore.createUri(relPath, hash);
			historySnapshotStore.store(snapshotUri, content);
			doc = await vscode.workspace.openTextDocument(snapshotUri);
		} else {
			doc = await vscode.workspace.openTextDocument({ content, language: languageId });
		}

		if (languageId && doc.languageId !== languageId) {
			try {
				doc = await vscode.languages.setTextDocumentLanguage(doc, languageId);
			} catch (error) {
				log('openCommit: failed to set language id', { languageId, error });
			}
		}

		const editor = await vscode.window.showTextDocument(doc, { preview: true });
		editor.options = { ...editor.options, readOnly: true };
		vscode.window.setStatusBarMessage(`Calgit history snapshot ${hash.slice(0, 7)} • ${relPath}`, 5000);
		log('openCommit: completed', { relPath, languageId, uri: doc.uri.toString() });
	}

	async openDiffWithCurrent(hash, fileUri) {
		log('openDiffWithCurrent: start', { hash, fileUri });
		const { uri, repoRoot, relPath } = await this.resolveFileContext(fileUri);
		const languageId = await this.getLanguageIdForUri(uri);
		const commitContent = await this.getCommitFileContent(repoRoot, hash, relPath);
		const leftDoc = await this.openSnapshotDocument(relPath, `${hash}-snapshot`, commitContent, languageId);
		const title = `Calgit ${relPath}: ${hash.slice(0, 7)} <-> Working Tree`;
		await vscode.commands.executeCommand('vscode.diff', leftDoc.uri, uri, title, { preview: true });
		vscode.window.setStatusBarMessage(`Calgit diff opened: ${hash.slice(0, 7)} vs working tree`, 4000);
		log('openDiffWithCurrent: completed', { relPath, hash });
	}

	async openDiffWithPrevious(hash, fileUri) {
		log('openDiffWithPrevious: start', { hash, fileUri });
		const { uri, repoRoot, relPath } = await this.resolveFileContext(fileUri);
		const languageId = await this.getLanguageIdForUri(uri);
		let previousHash;
		try {
			previousHash = (await this.execGit(repoRoot, ['rev-parse', `${hash}^`])).trim();
		} catch {
			throw new Error(`Commit ${hash.slice(0, 7)} has no parent to diff against.`);
		}
		if (!previousHash) {
			throw new Error(`Commit ${hash.slice(0, 7)} has no parent to diff against.`);
		}
		const previousContent = await this.getCommitFileContent(repoRoot, previousHash, relPath);
		const currentCommitContent = await this.getCommitFileContent(repoRoot, hash, relPath);
		const leftDoc = await this.openSnapshotDocument(relPath, `${previousHash}-base`, previousContent, languageId);
		const rightDoc = await this.openSnapshotDocument(relPath, `${hash}-target`, currentCommitContent, languageId);
		const title = `Calgit ${relPath}: ${previousHash.slice(0, 7)} <-> ${hash.slice(0, 7)}`;
		await vscode.commands.executeCommand('vscode.diff', leftDoc.uri, rightDoc.uri, title, { preview: true });
		vscode.window.setStatusBarMessage(`Calgit diff opened: ${hash.slice(0, 7)} vs previous`, 4000);
		log('openDiffWithPrevious: completed', { relPath, previousHash, hash });
	}

	async openDiffBetweenCommits(leftHash, rightHash, fileUri) {
		log('openDiffBetweenCommits: start', { leftHash, rightHash, fileUri });
		if (!leftHash || !rightHash) {
			throw new Error('Both commit hashes are required for diff.');
		}
		if (leftHash === rightHash) {
			throw new Error('Select two different commits to diff.');
		}
		const { uri, repoRoot, relPath } = await this.resolveFileContext(fileUri);
		const languageId = await this.getLanguageIdForUri(uri);
		const leftContent = await this.getCommitFileContent(repoRoot, leftHash, relPath);
		const rightContent = await this.getCommitFileContent(repoRoot, rightHash, relPath);
		const leftDoc = await this.openSnapshotDocument(relPath, `${leftHash}-left`, leftContent, languageId);
		const rightDoc = await this.openSnapshotDocument(relPath, `${rightHash}-right`, rightContent, languageId);
		const title = `Calgit ${relPath}: ${leftHash.slice(0, 7)} <-> ${rightHash.slice(0, 7)}`;
		await vscode.commands.executeCommand('vscode.diff', leftDoc.uri, rightDoc.uri, title, { preview: true });
		vscode.window.setStatusBarMessage(`Calgit diff opened: ${leftHash.slice(0, 7)} vs ${rightHash.slice(0, 7)}`, 4000);
		log('openDiffBetweenCommits: completed', { relPath, leftHash, rightHash });
	}

	/**
	 * @param {string} fileUri
	 */
	async resolveFileContext(fileUri) {
		if (!fileUri) {
			throw new Error('No file URI provided.');
		}
		const uri = vscode.Uri.parse(fileUri);
		if (uri.scheme !== 'file') {
			throw new Error(`Unsupported URI scheme: ${uri.scheme}`);
		}
		const repoRoot = await this.getRepositoryRootForUri(uri);
		if (!repoRoot) {
			throw new Error('No repository found for this file.');
		}
		const relPath = path.relative(repoRoot, uri.fsPath).replace(/\\/g, '/');
		if (relPath.startsWith('..')) {
			throw new Error('File is outside repository root.');
		}
		return { uri, repoRoot, relPath };
	}

	/**
	 * @param {string} repoRoot
	 * @param {string} hash
	 * @param {string} relPath
	 */
	async getCommitFileContent(repoRoot, hash, relPath) {
		try {
			return await this.execGit(repoRoot, ['show', `${hash}:${relPath}`]);
		} catch {
			throw new Error(`Unable to load ${relPath} at ${hash.slice(0, 7)}.`);
		}
	}

	/**
	 * @param {string} relPath
	 * @param {string} hash
	 * @param {string} content
	 * @param {string} languageId
	 */
	async openSnapshotDocument(relPath, hash, content, languageId) {
		if (!historySnapshotStore) {
			throw new Error('History snapshot store is unavailable.');
		}
		const snapshotUri = historySnapshotStore.createUri(relPath, hash);
		historySnapshotStore.store(snapshotUri, content);
		let doc = await vscode.workspace.openTextDocument(snapshotUri);
		if (languageId && doc.languageId !== languageId) {
			try {
				doc = await vscode.languages.setTextDocumentLanguage(doc, languageId);
			} catch (error) {
				log('openSnapshotDocument: failed to set language id', { languageId, error });
			}
		}
		return doc;
	}

	/**
	 * @param {vscode.Uri} uri
	 */
	async getLanguageIdForUri(uri) {
		try {
			const sourceDoc = await vscode.workspace.openTextDocument(uri);
			if (sourceDoc.languageId && sourceDoc.languageId !== 'plaintext') {
				return sourceDoc.languageId;
			}
		} catch (error) {
			log('getLanguageIdForUri: failed to inspect source document', { fileUri: uri.toString(), error });
		}
		return this.getLanguageIdFromExtension(path.extname(uri.fsPath).toLowerCase());
	}

	/**
	 * @param {string} extension
	 */
	getLanguageIdFromExtension(extension) {
		const extensionMap = {
			'.py': 'python',
			'.pyi': 'python',
			'.js': 'javascript',
			'.jsx': 'javascriptreact',
			'.ts': 'typescript',
			'.tsx': 'typescriptreact',
			'.json': 'json',
			'.md': 'markdown',
			'.yml': 'yaml',
			'.yaml': 'yaml',
			'.sh': 'shellscript',
			'.bash': 'shellscript',
			'.go': 'go',
			'.rs': 'rust',
			'.java': 'java',
			'.c': 'c',
			'.h': 'c',
			'.cpp': 'cpp',
			'.hpp': 'cpp',
			'.cs': 'csharp',
			'.php': 'php',
			'.rb': 'ruby',
			'.swift': 'swift',
			'.kt': 'kotlin',
			'.sql': 'sql',
			'.html': 'html',
			'.css': 'css',
			'.xml': 'xml',
			'.toml': 'toml'
		};
		return extensionMap[extension] || 'plaintext';
	}

	execGit(cwd, args) {
		log('execGit: running command', { cwd, args });
		return new Promise((resolve, reject) => {
			execFile('git', args, { cwd }, (err, stdout, stderr) => {
				if (err) {
					const details = stderr?.trim() || err.message;
					log('execGit: command failed', { args, cwd, details });
					reject(new Error(details));
				} else {
					resolve(stdout);
				}
			});
		});
	}

	async updateForEditor(editor) {
		if (!editor || editor.document.uri.scheme !== 'file') {
			log('updateForEditor: skipped non-file or missing editor');
			return;
		}
		log('updateForEditor: posting file uri', editor.document.uri.toString());
		this._webviewView?.webview.postMessage({ command: 'setFile', fileUri: editor.document.uri.toString() });
	}

	getHtmlForWebview(webview) {
		const nonce = getNonce();
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Calgit Calendar</title>
<style>
	body {
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		color: var(--vscode-foreground);
		background: var(--vscode-editor-background);
		padding: 8px;
	}
	#status {
		margin-bottom: 10px;
		opacity: 0.9;
	}
	#status.error {
		color: var(--vscode-errorForeground);
	}
	.calendarShell {
		border: 1px solid var(--vscode-panel-border);
		border-radius: 8px;
		padding: 8px;
		background: var(--vscode-editorWidget-background);
	}
	.calendarHeader {
		display: grid;
		grid-template-columns: 28px 1fr 28px auto;
		align-items: center;
		margin-bottom: 8px;
		column-gap: 8px;
	}
	#monthLabel {
		text-align: center;
		font-weight: 600;
	}
	.navButton {
		height: 28px;
		border: 1px solid var(--vscode-button-border);
		background: var(--vscode-button-secondaryBackground);
		color: var(--vscode-button-secondaryForeground);
		border-radius: 6px;
		cursor: pointer;
	}
	.navButton:hover {
		background: var(--vscode-button-secondaryHoverBackground);
	}
	#reloadHistoryButton {
		height: 28px;
		border: 1px solid var(--vscode-button-border);
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
		border-radius: 6px;
		cursor: pointer;
		padding: 0 10px;
	}
	#reloadHistoryButton:hover {
		background: var(--vscode-button-hoverBackground);
	}
	.weekdayRow {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		margin-bottom: 6px;
	}
	.weekdayCell {
		text-align: center;
		opacity: 0.8;
		font-size: 11px;
	}
	.calendarGrid {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		gap: 4px;
	}
	.dayCell {
		min-height: 40px;
		border: 1px solid var(--vscode-panel-border);
		border-radius: 6px;
		background: var(--vscode-editor-background);
		cursor: pointer;
		padding: 4px;
		text-align: left;
		position: relative;
	}
	.dayCell:disabled {
		cursor: default;
		opacity: 0.5;
	}
	.dayCell.outsideMonth {
		opacity: 0.45;
	}
	.dayCell.today {
		border-color: var(--vscode-focusBorder);
	}
	.dayCell.hasCommits {
		background: var(--vscode-list-hoverBackground);
	}
	.dayNumber {
		font-size: 11px;
	}
	.commitCount {
		position: absolute;
		right: 4px;
		bottom: 4px;
		font-size: 10px;
		padding: 0 4px;
		border-radius: 10px;
		background: var(--vscode-badge-background);
		color: var(--vscode-badge-foreground);
	}
		#commitInfo {
			margin-top: 10px;
			border: 1px solid var(--vscode-panel-border);
		border-radius: 8px;
		padding: 8px;
		background: var(--vscode-editor-background);
	}
	#commitInfo.empty {
		opacity: 0.75;
	}
	.infoTitle {
		font-weight: 600;
		margin-bottom: 6px;
	}
	.infoRow {
		margin: 2px 0;
		word-break: break-word;
	}
		.infoLabel {
			opacity: 0.75;
			margin-right: 6px;
		}
		#dayCommitList {
			margin-top: 8px;
			border: 1px solid var(--vscode-panel-border);
			border-radius: 8px;
			padding: 8px;
			background: var(--vscode-editor-background);
		}
		#dayCommitList.empty {
			opacity: 0.75;
		}
		.dayCommitTitle {
			font-weight: 600;
			margin-bottom: 6px;
		}
		.dayCommitItem {
			display: block;
			width: 100%;
			text-align: left;
			border: 1px solid var(--vscode-panel-border);
			background: var(--vscode-editor-background);
			color: var(--vscode-foreground);
			border-radius: 6px;
			padding: 6px 8px;
			margin: 4px 0;
			cursor: pointer;
		}
		.dayCommitItem:hover {
			background: var(--vscode-list-hoverBackground);
		}
		.dayCommitItem.active {
			border-color: var(--vscode-focusBorder);
			background: var(--vscode-list-activeSelectionBackground);
			color: var(--vscode-list-activeSelectionForeground);
		}
		.dayCommitMeta {
			font-size: 11px;
			opacity: 0.85;
			margin-bottom: 2px;
		}
		.dayCommitMessage {
			font-size: 12px;
			word-break: break-word;
		}
		.contextMenu {
		position: fixed;
		z-index: 9999;
		min-width: 220px;
		border: 1px solid var(--vscode-menu-border);
		background: var(--vscode-menu-background);
		color: var(--vscode-menu-foreground);
		border-radius: 6px;
		padding: 4px;
		box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
	}
	.contextMenu.hidden {
		display: none;
	}
	.contextMenuItem {
		display: block;
		width: 100%;
		text-align: left;
		background: transparent;
		border: 0;
		color: inherit;
		padding: 6px 8px;
		border-radius: 4px;
		cursor: pointer;
	}
	.contextMenuItem:hover:not(:disabled) {
		background: var(--vscode-menu-selectionBackground);
		color: var(--vscode-menu-selectionForeground);
	}
	.contextMenuItem:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.contextMenuHint {
		padding: 4px 8px;
		font-size: 11px;
		opacity: 0.75;
	}
</style>
</head>
<body>
<div id="status">Open a file to load commit history.</div>
<div class="calendarShell">
	<div class="calendarHeader">
		<button id="prevMonth" class="navButton" aria-label="Previous month">&#8249;</button>
		<div id="monthLabel"></div>
		<button id="nextMonth" class="navButton" aria-label="Next month">&#8250;</button>
		<button id="reloadHistoryButton" aria-label="Reload history">Reload</button>
	</div>
	<div id="weekdayRow" class="weekdayRow"></div>
	<div id="calendarGrid" class="calendarGrid"></div>
</div>
<div id="commitInfo" class="empty">Select a highlighted day to view commit details.</div>
<div id="dayCommitList" class="empty">Select a day with multiple commits to see all options.</div>
<div id="contextMenu" class="contextMenu hidden"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let commitsByDate = {};
let displayYear = null;
let displayMonth = null;
let currentFileUri = null;
let activeCommit = null;
let compareBaseCommit = null;
let selectedDayKey = null;
let selectedDayCommits = [];
const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function setStatus(text, level = 'info') {
   const status = document.getElementById('status');
   status.textContent = text;
   status.className = level === 'error' ? 'error' : '';
}

function shortHash(hash) {
   return String(hash || '').slice(0, 7);
}

function sortCommitsNewestFirst(commits) {
   return (commits || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function pad2(value) {
   return String(value).padStart(2, '0');
}

function toDateKey(dateObj) {
   return dateObj.getFullYear() + '-' + pad2(dateObj.getMonth() + 1) + '-' + pad2(dateObj.getDate());
}

function parseDateKey(key) {
   const parts = String(key).split('-').map(Number);
   if (parts.length !== 3 || parts.some(n => Number.isNaN(n))) {
      return null;
   }
   return new Date(parts[0], parts[1] - 1, parts[2]);
}

function resetDisplayMonthToLatestCommit() {
   const keys = Object.keys(commitsByDate).sort();
   if (keys.length === 0) {
      const today = new Date();
      displayYear = today.getFullYear();
      displayMonth = today.getMonth();
      return;
   }
   const latest = parseDateKey(keys[keys.length - 1]);
   if (!latest) {
      const today = new Date();
      displayYear = today.getFullYear();
      displayMonth = today.getMonth();
      return;
   }
   displayYear = latest.getFullYear();
   displayMonth = latest.getMonth();
}

function indexCommits(commits) {
   commitsByDate = {};
   if (!Array.isArray(commits)) {
      return;
   }
   commits.forEach(c => {
      if (!c || typeof c.date !== 'string') {
         return;
      }
      const key = c.date.slice(0, 10);
      if (!commitsByDate[key]) {
         commitsByDate[key] = [];
      }
      commitsByDate[key].push(c);
   });
}

function renderWeekdays() {
   const row = document.getElementById('weekdayRow');
   row.innerHTML = '';
   weekdayNames.forEach(name => {
      const cell = document.createElement('div');
      cell.className = 'weekdayCell';
      cell.textContent = name;
      row.appendChild(cell);
   });
}

function renderCalendar() {
   if (displayYear === null || displayMonth === null) {
      resetDisplayMonthToLatestCommit();
   }

   document.getElementById('monthLabel').textContent = monthNames[displayMonth] + ' ' + displayYear;
   const grid = document.getElementById('calendarGrid');
   grid.innerHTML = '';

   const todayKey = toDateKey(new Date());
   const firstWeekday = new Date(displayYear, displayMonth, 1).getDay();
   const daysInMonth = new Date(displayYear, displayMonth + 1, 0).getDate();
   const prevMonthDays = new Date(displayYear, displayMonth, 0).getDate();

   for (let i = 0; i < 42; i++) {
      let dayNumber = 0;
      let monthOffset = 0;
      if (i < firstWeekday) {
         dayNumber = prevMonthDays - firstWeekday + i + 1;
         monthOffset = -1;
      } else if (i >= firstWeekday + daysInMonth) {
         dayNumber = i - (firstWeekday + daysInMonth) + 1;
         monthOffset = 1;
      } else {
         dayNumber = i - firstWeekday + 1;
      }

      const dayDate = new Date(displayYear, displayMonth + monthOffset, dayNumber);
      const dateKey = toDateKey(dayDate);
      const dayCommits = sortCommitsNewestFirst(commitsByDate[dateKey] || []);

      const button = document.createElement('button');
      button.className = 'dayCell';
      if (monthOffset !== 0) {
         button.classList.add('outsideMonth');
      }
      if (dateKey === todayKey) {
         button.classList.add('today');
      }
      if (dayCommits.length > 0) {
         button.classList.add('hasCommits');
      } else {
         button.disabled = true;
      }

      const dayText = document.createElement('div');
      dayText.className = 'dayNumber';
      dayText.textContent = String(dayNumber);
      button.appendChild(dayText);

      if (dayCommits.length > 0) {
         const badge = document.createElement('div');
         badge.className = 'commitCount';
         badge.textContent = String(dayCommits.length);
         button.appendChild(badge);
         button.title = dayCommits.slice(0, 5).map(c => c.message).join('\\n');
         button.onclick = () => onDateClick(dateKey);
         button.oncontextmenu = event => {
            event.preventDefault();
            showCommitContextMenu(event, dayCommits[0], dayCommits.length);
         };
      }

      grid.appendChild(button);
   }
}

function shiftMonth(delta) {
   const shifted = new Date(displayYear, displayMonth + delta, 1);
   displayYear = shifted.getFullYear();
   displayMonth = shifted.getMonth();
   renderCalendar();
}

function clearCommitInfo(text = 'Select a highlighted day to view commit details.') {
   activeCommit = null;
   const panel = document.getElementById('commitInfo');
   panel.className = 'empty';
   panel.textContent = text;
}

function createInfoRow(label, value) {
   const row = document.createElement('div');
   row.className = 'infoRow';
   const labelSpan = document.createElement('span');
   labelSpan.className = 'infoLabel';
   labelSpan.textContent = label + ':';
   const valueSpan = document.createElement('span');
   valueSpan.textContent = value;
   row.appendChild(labelSpan);
   row.appendChild(valueSpan);
   return row;
}

function formatCommitDate(isoDate) {
   const d = new Date(isoDate);
   if (Number.isNaN(d.getTime())) {
      return isoDate;
   }
   return d.toLocaleString();
}

function formatCommitTime(isoDate) {
   const d = new Date(isoDate);
   if (Number.isNaN(d.getTime())) {
      return isoDate;
   }
   return d.toLocaleTimeString();
}

function showCommitInfo(commit, note = '') {
   activeCommit = commit || null;
   const panel = document.getElementById('commitInfo');
   panel.className = '';
   panel.innerHTML = '';

   const title = document.createElement('div');
   title.className = 'infoTitle';
   title.textContent = 'Commit Details';
   panel.appendChild(title);

   panel.appendChild(createInfoRow('Hash', commit.hash || 'unknown'));
   panel.appendChild(createInfoRow('When', formatCommitDate(commit.date || 'unknown')));
   panel.appendChild(createInfoRow('Author', commit.author || 'unknown'));
   panel.appendChild(createInfoRow('Message', commit.message || ''));
   if (compareBaseCommit) {
      panel.appendChild(createInfoRow('Compare Base', shortHash(compareBaseCommit.hash)));
   }
   if (note) {
      panel.appendChild(createInfoRow('Action', note));
   }
}

function clearDayCommitList(text = 'Select a day with multiple commits to see all options.') {
   selectedDayKey = null;
   selectedDayCommits = [];
   const panel = document.getElementById('dayCommitList');
   panel.className = 'empty';
   panel.textContent = text;
}

function renderDayCommitList(date, options, selectedHash = '') {
   selectedDayKey = date;
   selectedDayCommits = (options || []).slice();

   const panel = document.getElementById('dayCommitList');
   panel.className = '';
   panel.innerHTML = '';

   const title = document.createElement('div');
   title.className = 'dayCommitTitle';
   title.textContent = 'Commits on ' + date + ' (' + String(selectedDayCommits.length) + ')';
   panel.appendChild(title);

   selectedDayCommits.forEach(commit => {
      const item = document.createElement('button');
      item.className = 'dayCommitItem';
      if (selectedHash && commit.hash === selectedHash) {
         item.classList.add('active');
      }

      const meta = document.createElement('div');
      meta.className = 'dayCommitMeta';
      meta.textContent = shortHash(commit.hash) + '  ' + formatCommitTime(commit.date) + '  ' + (commit.author || 'unknown');
      item.appendChild(meta);

      const message = document.createElement('div');
      message.className = 'dayCommitMessage';
      message.textContent = commit.message || '';
      item.appendChild(message);

      item.onclick = () => {
         showCommitInfo(commit, 'Opening snapshot');
         renderDayCommitList(date, selectedDayCommits, commit.hash);
         vscode.postMessage({ command: 'openCommit', hash: commit.hash, fileUri: commit.fileUri });
      };
      item.oncontextmenu = event => {
         event.preventDefault();
         showCommitContextMenu(event, commit, selectedDayCommits.length);
      };
      panel.appendChild(item);
   });
}

function hideContextMenu() {
   const menu = document.getElementById('contextMenu');
   menu.classList.add('hidden');
   menu.innerHTML = '';
}

function appendContextMenuButton(menu, label, onClick, disabled = false) {
   const button = document.createElement('button');
   button.className = 'contextMenuItem';
   button.textContent = label;
   button.disabled = disabled;
   button.onclick = () => {
      hideContextMenu();
      if (!disabled) {
         onClick();
      }
   };
   menu.appendChild(button);
}

function appendContextMenuHint(menu, text) {
   const hint = document.createElement('div');
   hint.className = 'contextMenuHint';
   hint.textContent = text;
   menu.appendChild(hint);
}

function showCommitContextMenu(event, commit, commitCountForDay = 1) {
   if (!commit) {
      return;
   }
   activeCommit = commit;
   const menu = document.getElementById('contextMenu');
   menu.innerHTML = '';

   appendContextMenuHint(menu, 'Commit ' + shortHash(commit.hash));
   if (commitCountForDay > 1) {
      appendContextMenuHint(menu, 'Using latest of ' + String(commitCountForDay) + ' commits on this day');
   }

   appendContextMenuButton(menu, 'Open Snapshot', () => {
      showCommitInfo(commit, 'Opening snapshot');
      vscode.postMessage({ command: 'openCommit', hash: commit.hash, fileUri: commit.fileUri });
   });
   appendContextMenuButton(menu, 'Diff vs Current File', () => {
      showCommitInfo(commit, 'Opening diff vs working tree');
      vscode.postMessage({ command: 'openDiffWithCurrent', hash: commit.hash, fileUri: commit.fileUri });
   });
   appendContextMenuButton(menu, 'Diff vs Previous Version', () => {
      showCommitInfo(commit, 'Opening diff vs previous commit');
      vscode.postMessage({ command: 'openDiffWithPrevious', hash: commit.hash, fileUri: commit.fileUri });
   });
   appendContextMenuButton(menu, 'Set ' + shortHash(commit.hash) + ' as Compare Base', () => {
      compareBaseCommit = commit;
      showCommitInfo(commit, 'Compare base updated');
      setStatus('Compare base set to ' + shortHash(commit.hash) + '.');
   });

   const canCompareWithBase = !!compareBaseCommit && compareBaseCommit.fileUri === commit.fileUri && compareBaseCommit.hash !== commit.hash;
   const compareLabel = compareBaseCommit
      ? 'Diff ' + shortHash(compareBaseCommit.hash) + ' <-> ' + shortHash(commit.hash)
      : 'Diff with Compare Base';
   appendContextMenuButton(menu, compareLabel, () => {
      showCommitInfo(commit, 'Opening diff vs ' + shortHash(compareBaseCommit.hash));
      vscode.postMessage({
         command: 'openDiffBetweenCommits',
         leftHash: compareBaseCommit.hash,
         rightHash: commit.hash,
         fileUri: commit.fileUri
      });
   }, !canCompareWithBase);

   appendContextMenuButton(menu, 'Clear Compare Base', () => {
      compareBaseCommit = null;
      if (activeCommit) {
         showCommitInfo(activeCommit, 'Compare base cleared');
      } else {
         clearCommitInfo();
      }
      setStatus('Compare base cleared.');
   }, !compareBaseCommit);

   menu.classList.remove('hidden');
   const maxLeft = window.innerWidth - 240;
   const maxTop = window.innerHeight - 220;
   menu.style.left = Math.max(8, Math.min(event.clientX, maxLeft)) + 'px';
   menu.style.top = Math.max(8, Math.min(event.clientY, maxTop)) + 'px';
}

function requestCurrentFileCommits() {
   hideContextMenu();
   clearDayCommitList('Loading day commits...');
   if (!currentFileUri) {
      setStatus('Resolving active file...');
      clearCommitInfo('Trying to detect active file...');
      vscode.postMessage({command:'requestActiveFile'});
      return;
   }
   setStatus('Loading commits...');
   clearCommitInfo('Loading commit details...');
   vscode.postMessage({command:'requestCommits', fileUri: currentFileUri});
}

window.addEventListener('message', event => {
   const msg = event.data;
   if (msg.command === 'setFile') {
      currentFileUri = msg.fileUri || null;
      compareBaseCommit = null;
      activeCommit = null;
      requestCurrentFileCommits();
   } else if (msg.command === 'commits') {
      indexCommits(msg.commits);
      resetDisplayMonthToLatestCommit();
      renderCalendar();
      const count = Array.isArray(msg.commits) ? msg.commits.length : 0;
      setStatus(count > 0 ? 'Loaded ' + count + ' commit(s).' : 'No commits found for this file in the current branch.');
      clearCommitInfo(count > 0 ? 'Select a highlighted day to view commit details.' : 'No commit details available for this file.');
      clearDayCommitList(count > 0 ? 'Select a day to list all commits for that day.' : 'No day options available for this file.');
   } else if (msg.command === 'status') {
      setStatus(msg.message, msg.level);
   }
});
function onDateClick(date) {
   hideContextMenu();
   const options = sortCommitsNewestFirst(commitsByDate[date] || []);
   if (options.length === 0) {
      return;
   }
   renderDayCommitList(date, options, options[0].hash);
   if (options.length === 1) {
      showCommitInfo(options[0], 'Opening snapshot');
      vscode.postMessage({command:'openCommit', hash: options[0].hash, fileUri: options[0].fileUri});
   } else {
      showCommitInfo(options[0], 'Selected latest commit for this day. Pick any entry below to open it.');
   }
}
document.getElementById('prevMonth').addEventListener('click', () => shiftMonth(-1));
document.getElementById('nextMonth').addEventListener('click', () => shiftMonth(1));
document.getElementById('reloadHistoryButton').addEventListener('click', () => requestCurrentFileCommits());
document.getElementById('commitInfo').addEventListener('contextmenu', event => {
   if (!activeCommit) {
      return;
   }
   event.preventDefault();
   showCommitContextMenu(event, activeCommit, 1);
});
window.addEventListener('click', () => hideContextMenu());
window.addEventListener('blur', () => hideContextMenu());
window.addEventListener('scroll', () => hideContextMenu(), true);
window.addEventListener('keydown', event => {
   if (event.key === 'Escape') {
      hideContextMenu();
   }
});
renderWeekdays();
resetDisplayMonthToLatestCommit();
renderCalendar();
</script>
</body>
</html>`;
	}
}

function activate(context) {
	outputChannel = vscode.window.createOutputChannel('Calgit');
	context.subscriptions.push(outputChannel);
	const packageJson = context.extension.packageJSON || {};
	const contributedViews = packageJson.contributes?.views?.calgit || [];
	const contributedCalendarView = contributedViews.find(v => v.id === CalendarViewProvider.viewType) || null;
	log('activate: start', {
		extensionPath: context.extensionPath,
		workspaceFolders: (vscode.workspace.workspaceFolders || []).map(wf => wf.uri.fsPath),
		activationEvent: 'onView:calgit.calendarView',
		manifestVersion: packageJson.version,
		manifestCalendarView: contributedCalendarView
	});

	historySnapshotStore = new HistorySnapshotStore();
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(HISTORY_SCHEME, {
			provideTextDocumentContent: uri => historySnapshotStore?.provideTextDocumentContent(uri) || ''
		})
	);
	context.subscriptions.push(
		vscode.workspace.onDidCloseTextDocument(doc => {
			if (doc.uri.scheme === HISTORY_SCHEME) {
				historySnapshotStore?.delete(doc.uri);
				log('history snapshot disposed', doc.uri.toString());
			}
		})
	);

	log('activate: history snapshot provider registered', HISTORY_SCHEME);

	// register calendar view provider
	const provider = new CalendarViewProvider(context);
	try {
		context.subscriptions.push(
			vscode.window.registerWebviewViewProvider(
				CalendarViewProvider.viewType,
				provider
			)
		);
		log('activate: registered webview view provider', CalendarViewProvider.viewType);
	} catch (error) {
		log('activate: failed to register webview view provider', error);
		throw error;
	}

	// update calendar when active editor changes
	const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(editor => {
		log('onDidChangeActiveTextEditor', editor ? editor.document.uri.toString() : 'undefined');
		enforceHistoryEditorReadOnly(editor);
		provider.updateForEditor(editor);
	});
	context.subscriptions.push(editorChangeDisposable);
	enforceHistoryEditorsReadOnly(vscode.window.visibleTextEditors);
	const visibleEditorsDisposable = vscode.window.onDidChangeVisibleTextEditors(editors => {
		enforceHistoryEditorsReadOnly(editors);
	});
	context.subscriptions.push(visibleEditorsDisposable);

	// existing helloWorld command left for compatibility
	const disposable = vscode.commands.registerCommand('calgit.helloWorld', function () {
		log('command calgit.helloWorld executed');
		vscode.window.showInformationMessage('Hello World from Calgit!');
	});
	context.subscriptions.push(disposable);

	const debugLogCommand = vscode.commands.registerCommand('calgit.showDebugLog', () => {
		outputChannel?.show(true);
		log('command calgit.showDebugLog executed');
	});
	context.subscriptions.push(debugLogCommand);

	log('activate: completed');
}

// https://www.npmjs.com/package/vscode-webview or generic nonce generator
function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

// This method is called when your extension is deactivated
function deactivate() {
	log('deactivate: called');
	historySnapshotStore = null;
}

module.exports = {
	activate,
	deactivate
}
