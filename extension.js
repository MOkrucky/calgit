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
		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				log('resolveWebviewView: webview became visible, refreshing active file');
				this.sendActiveFileToWebview();
			}
		});

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
				`--pretty=format:%H%x1f%aI%x1f%an <%ae>%x1f%s%x1f%D%x1e`,
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
<div id="commitInfo" class="empty">Select a highlighted day to view commit details.</div>
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
