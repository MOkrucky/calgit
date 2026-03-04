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
			const [hash, date, author, message, refs] = entry.split(LOG_FIELD_SEPARATOR);
			return { hash, date, author, message, refs: refs ? refs.trim() : '', fileUri };
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
		this._lastPostedFileUri = null;
		this._latestCommitRequestId = 0;
		log('CalendarViewProvider: created', { extensionPath: context.extensionPath });
	}

	/**
	 * @param {string} message
	 * @param {'info' | 'error' | 'loading'} level
	 * @param {number | null} requestId
	 */
	postWebviewStatus(message, level = 'info', requestId = null) {
		const payload = { command: 'status', message, level };
		if (Number.isInteger(requestId)) {
			payload.requestId = requestId;
		}
		this._webviewView?.webview.postMessage(payload);
	}

	/**
	 * @param {number | null | undefined} requestId
	 */
	normalizeRequestId(requestId) {
		return Number.isInteger(requestId) ? requestId : null;
	}

	/**
	 * @param {number | null} requestId
	 */
	isCommitRequestStale(requestId) {
		return Number.isInteger(requestId) && requestId !== this._latestCommitRequestId;
	}

	/**
	 * @param {string | null} fileUri
	 * @param {boolean} force
	 */
	postActiveFileToWebview(fileUri, force = false) {
		if (!this._webviewView) {
			return false;
		}
		if (!force && this._lastPostedFileUri === fileUri) {
			log('postActiveFileToWebview: skipped duplicate file', fileUri);
			return false;
		}
		this._lastPostedFileUri = fileUri;
		this._webviewView.webview.postMessage({ command: 'setFile', fileUri });
		return true;
	}

	/**
	 * @param {string | null} fileUri
	 * @param {number | null} requestId
	 * @param {Array<unknown>} commits
	 * @param {string} statusMessage
	 * @param {'info' | 'error'} statusLevel
	 */
	postCommitsResult(fileUri, requestId, commits, statusMessage, statusLevel = 'info') {
		if (this.isCommitRequestStale(requestId)) {
			log('postCommitsResult: ignored stale request result', { requestId, latest: this._latestCommitRequestId, fileUri });
			return false;
		}
		this._webviewView?.webview.postMessage({
			command: 'commits',
			fileUri,
			requestId,
			commits,
			statusMessage,
			statusLevel
		});
		return true;
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
						await this.provideCommits(message.fileUri, message.requestId);
						break;
					case 'requestActiveFile':
						this.sendActiveFileToWebview(true);
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
			this._webviewView = null;
			this._lastPostedFileUri = null;
		});
		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				log('resolveWebviewView: webview became visible, refreshing active file');
				this.sendActiveFileToWebview(true);
			}
		});

		this.sendActiveFileToWebview(true);
	}

	sendActiveFileToWebview(force = false) {
		const editor = vscode.window.activeTextEditor;
		if (editor && editor.document.uri.scheme === 'file') {
			const fileUri = editor.document.uri.toString();
			const posted = this.postActiveFileToWebview(fileUri, force);
			log(posted ? 'sendActiveFileToWebview: posted active file' : 'sendActiveFileToWebview: active file already posted', fileUri);
			return;
		}
		log('sendActiveFileToWebview: no active file editor found');
		this.postWebviewStatus('No active file selected.', 'error');
	}

	async provideCommits(fileUri, requestId = null) {
		const normalizedRequestId = this.normalizeRequestId(requestId);
		if (Number.isInteger(normalizedRequestId) && normalizedRequestId > this._latestCommitRequestId) {
			this._latestCommitRequestId = normalizedRequestId;
		}
		log('provideCommits: start', { fileUri, requestId: normalizedRequestId });
		if (this.isCommitRequestStale(normalizedRequestId)) {
			log('provideCommits: stale request ignored before processing', { requestId: normalizedRequestId, latest: this._latestCommitRequestId, fileUri });
			return;
		}
		if (!fileUri) {
			this.postCommitsResult(fileUri, normalizedRequestId, [], 'No file selected.', 'error');
			return;
		}
		const uri = vscode.Uri.parse(fileUri);
		if (uri.scheme !== 'file') {
			this.postCommitsResult(fileUri, normalizedRequestId, [], `Unsupported URI scheme: ${uri.scheme}`, 'error');
			return;
		}
		const repoRoot = await this.getRepositoryRootForUri(uri);
		if (this.isCommitRequestStale(normalizedRequestId)) {
			log('provideCommits: stale request ignored after repository resolution', { requestId: normalizedRequestId, latest: this._latestCommitRequestId, fileUri });
			return;
		}
		if (!repoRoot) {
			log('provideCommits: no matching repository', { fileUri });
			this.postCommitsResult(
				fileUri,
				normalizedRequestId,
				[],
				'No Git repository found for this file. Open the repository root or enable Git parent repository discovery.',
				'error'
			);
			return;
		}
		const relPath = path.relative(repoRoot, uri.fsPath).replace(/\\/g, '/');
		if (relPath.startsWith('..')) {
			log('provideCommits: file is outside repository root', { repoRoot, filePath: uri.fsPath });
			this.postCommitsResult(fileUri, normalizedRequestId, [], 'The active file is outside the detected repository root.', 'error');
			return;
		}
		this.postWebviewStatus(`Loading commits for ${relPath}...`, 'loading', normalizedRequestId);
		const [allRefsLogRaw, currentBranchLogRaw, currentBranchNameRaw] = await Promise.all([
			this.execGit(repoRoot, [
				'log',
				'--all',
				'--decorate=short',
				'--follow',
				'--date=iso-strict',
				`--pretty=format:%H%x1f%aI%x1f%an <%ae>%x1f%s%x1f%D%x1e`,
				'--',
				relPath
			]),
			this.execGit(repoRoot, [
				'log',
				'--follow',
				'--pretty=format:%H',
				'--',
				relPath
			]),
			this.execGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
		]);
		if (this.isCommitRequestStale(normalizedRequestId)) {
			log('provideCommits: stale request ignored after git log execution', { requestId: normalizedRequestId, latest: this._latestCommitRequestId, relPath });
			return;
		}
		const allCommits = parseGitLogOutput(allRefsLogRaw, fileUri);
		const currentBranchHashes = new Set(
			currentBranchLogRaw
				.split(/\r?\n/)
				.map(line => line.trim())
				.filter(Boolean)
		);
		const currentBranchName = currentBranchNameRaw.trim();
		const commits = allCommits.map(commit => ({
			...commit,
			branchScope: currentBranchHashes.has(commit.hash) ? 'current' : 'other',
			currentBranchName
		}));
		log('provideCommits: commits resolved', { relPath, commitCount: commits.length, currentBranchName });
		if (commits.length === 0) {
			this.postCommitsResult(fileUri, normalizedRequestId, commits, 'No commits found for this file across local and remote branches.');
		} else {
			this.postCommitsResult(fileUri, normalizedRequestId, commits, `Loaded ${commits.length} commit(s) for ${relPath}.`);
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
		const pathInfo = await this.getFilePathsForCommitAndParent(repoRoot, hash, relPath);
		if (!pathInfo.pathAtHash) {
			throw new Error(`Commit ${hash.slice(0, 7)} does not contain ${relPath}.`);
		}
		const content = await this.getCommitFileContent(repoRoot, hash, pathInfo.pathAtHash);
		const languageId = await this.getLanguageIdForUri(uri);
		let doc;

		if (historySnapshotStore) {
			const snapshotUri = historySnapshotStore.createUri(pathInfo.pathAtHash, hash);
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

		await vscode.window.showTextDocument(doc, { preview: true });
		vscode.window.setStatusBarMessage(`Calgit history snapshot ${hash.slice(0, 7)} • ${pathInfo.pathAtHash}`, 5000);
		log('openCommit: completed', { relPath: pathInfo.pathAtHash, languageId, uri: doc.uri.toString() });
	}

	async openDiffWithCurrent(hash, fileUri) {
		log('openDiffWithCurrent: start', { hash, fileUri });
		const { uri, repoRoot, relPath } = await this.resolveFileContext(fileUri);
		const languageId = await this.getLanguageIdForUri(uri);
		const pathInfo = await this.getFilePathsForCommitAndParent(repoRoot, hash, relPath);
		if (!pathInfo.pathAtHash) {
			throw new Error(`Commit ${hash.slice(0, 7)} does not contain ${relPath}.`);
		}
		const commitContent = await this.getCommitFileContent(repoRoot, hash, pathInfo.pathAtHash);
		const leftDoc = await this.openSnapshotDocument(pathInfo.pathAtHash, `${hash}-snapshot`, commitContent, languageId);
		const title = `Calgit ${pathInfo.pathAtHash}: ${hash.slice(0, 7)} <-> Working Tree`;
		await vscode.commands.executeCommand('vscode.diff', leftDoc.uri, uri, title, { preview: true });
		vscode.window.setStatusBarMessage(`Calgit diff opened: ${hash.slice(0, 7)} vs working tree`, 4000);
		log('openDiffWithCurrent: completed', { relPath: pathInfo.pathAtHash, hash });
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
		const pathInfo = await this.getFilePathsForCommitAndParent(repoRoot, hash, relPath);
		if (!pathInfo.pathAtHash) {
			throw new Error(`Commit ${hash.slice(0, 7)} does not contain this file version.`);
		}
		if (!pathInfo.pathAtParent) {
			throw new Error(`Commit ${hash.slice(0, 7)} has no previous file version to diff against.`);
		}
		const previousContent = await this.getCommitFileContent(repoRoot, previousHash, pathInfo.pathAtParent);
		const currentCommitContent = await this.getCommitFileContent(repoRoot, hash, pathInfo.pathAtHash);
		const leftDoc = await this.openSnapshotDocument(pathInfo.pathAtParent, `${previousHash}-base`, previousContent, languageId);
		const rightDoc = await this.openSnapshotDocument(pathInfo.pathAtHash, `${hash}-target`, currentCommitContent, languageId);
		const titlePath = pathInfo.pathAtParent === pathInfo.pathAtHash ? pathInfo.pathAtHash : `${pathInfo.pathAtParent} -> ${pathInfo.pathAtHash}`;
		const title = `Calgit ${titlePath}: ${previousHash.slice(0, 7)} <-> ${hash.slice(0, 7)}`;
		await vscode.commands.executeCommand('vscode.diff', leftDoc.uri, rightDoc.uri, title, { preview: true });
		vscode.window.setStatusBarMessage(`Calgit diff opened: ${hash.slice(0, 7)} vs previous`, 4000);
		log('openDiffWithPrevious: completed', {
			relPathAtParent: pathInfo.pathAtParent,
			relPathAtHash: pathInfo.pathAtHash,
			previousHash,
			hash
		});
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
		const leftPathInfo = await this.getFilePathsForCommitAndParent(repoRoot, leftHash, relPath);
		const rightPathInfo = await this.getFilePathsForCommitAndParent(repoRoot, rightHash, relPath);
		if (!leftPathInfo.pathAtHash || !rightPathInfo.pathAtHash) {
			throw new Error('Unable to resolve file path for one of the selected commits.');
		}
		const leftContent = await this.getCommitFileContent(repoRoot, leftHash, leftPathInfo.pathAtHash);
		const rightContent = await this.getCommitFileContent(repoRoot, rightHash, rightPathInfo.pathAtHash);
		const leftDoc = await this.openSnapshotDocument(leftPathInfo.pathAtHash, `${leftHash}-left`, leftContent, languageId);
		const rightDoc = await this.openSnapshotDocument(rightPathInfo.pathAtHash, `${rightHash}-right`, rightContent, languageId);
		const titlePath = leftPathInfo.pathAtHash === rightPathInfo.pathAtHash
			? leftPathInfo.pathAtHash
			: `${leftPathInfo.pathAtHash} <-> ${rightPathInfo.pathAtHash}`;
		const title = `Calgit ${titlePath}: ${leftHash.slice(0, 7)} <-> ${rightHash.slice(0, 7)}`;
		await vscode.commands.executeCommand('vscode.diff', leftDoc.uri, rightDoc.uri, title, { preview: true });
		vscode.window.setStatusBarMessage(`Calgit diff opened: ${leftHash.slice(0, 7)} vs ${rightHash.slice(0, 7)}`, 4000);
		log('openDiffBetweenCommits: completed', {
			leftHash,
			rightHash,
			leftPath: leftPathInfo.pathAtHash,
			rightPath: rightPathInfo.pathAtHash
		});
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
	 * @param {string} statusCode
	 * @param {string[]} paths
	 * @param {string} fallbackPath
	 */
	resolvePathsFromNameStatus(statusCode, paths, fallbackPath) {
		if (!statusCode || paths.length === 0) {
			return { pathAtHash: fallbackPath, pathAtParent: fallbackPath };
		}
		if (statusCode.startsWith('R') || statusCode.startsWith('C')) {
			if (paths.length >= 2) {
				return { pathAtHash: paths[1], pathAtParent: paths[0] };
			}
			return { pathAtHash: fallbackPath, pathAtParent: fallbackPath };
		}
		if (statusCode.startsWith('A')) {
			return { pathAtHash: paths[0], pathAtParent: null };
		}
		if (statusCode.startsWith('D')) {
			return { pathAtHash: null, pathAtParent: paths[0] };
		}
		return { pathAtHash: paths[0], pathAtParent: paths[0] };
	}

	/**
	 * @param {string} repoRoot
	 * @param {string} hash
	 * @param {string} relPath
	 */
	async getFilePathsForCommitAndParent(repoRoot, hash, relPath) {
		const fallback = { pathAtHash: relPath, pathAtParent: relPath };
		let raw = '';
		try {
			raw = await this.execGit(repoRoot, ['log', '--follow', '--name-status', '--format=%H', '--', relPath]);
		} catch (error) {
			log('getFilePathsForCommitAndParent: failed to resolve from name-status log, using fallback', { hash, relPath, error });
			return fallback;
		}
		if (!raw.trim()) {
			return fallback;
		}
		const lines = raw.split(/\r?\n/);
		const commitHashPattern = /^[0-9a-f]{40}$/;
		let currentCommitHash = '';
		let currentStatusLines = [];
		const evaluateCurrent = () => {
			if (currentCommitHash !== hash) {
				return null;
			}
			const statusLine = currentStatusLines.find(line => line.trim().length > 0) || '';
			const [statusCode = '', ...paths] = statusLine.split('\t').map(part => part.trim()).filter(Boolean);
			return this.resolvePathsFromNameStatus(statusCode, paths, relPath);
		};
		for (const line of lines) {
			const trimmed = line.trim();
			if (commitHashPattern.test(trimmed)) {
				const evaluated = evaluateCurrent();
				if (evaluated) {
					return evaluated;
				}
				currentCommitHash = trimmed;
				currentStatusLines = [];
				continue;
			}
			if (!trimmed) {
				continue;
			}
			if (currentCommitHash) {
				currentStatusLines.push(line);
			}
		}
		return evaluateCurrent() || fallback;
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
		if (!this._webviewView || !this._webviewView.visible) {
			log('updateForEditor: skipped because webview is not visible');
			return;
		}
		if (!editor || editor.document.uri.scheme !== 'file') {
			log('updateForEditor: skipped non-file or missing editor');
			return;
		}
		const fileUri = editor.document.uri.toString();
		const posted = this.postActiveFileToWebview(fileUri);
		log(posted ? 'updateForEditor: posted file uri' : 'updateForEditor: skipped duplicate file uri', fileUri);
	}

	getHtmlForWebview(webview) {
		const nonce = getNonce();
		const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'resources', 'webview.css'));
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'resources', 'webview.js'));
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource} 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Calgit Calendar</title>
<link rel="stylesheet" href="${cssUri}">
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
	<div id="compareState" class="empty">Select a commit to see compare state.</div>
	<div id="dayCommitList" class="empty">Select a day with multiple commits to see all options.</div>
	<div id="contextMenu" class="contextMenu hidden"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
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
