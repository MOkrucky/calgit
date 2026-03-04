const assert = require('assert');

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
const vscode = require('vscode');
// const myExtension = require('../extension');

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('activate extension and calendar view exists', async () => {
		// the id may include a publisher; search by package name
		const extension = vscode.extensions.all.find(ext => ext.packageJSON.name === 'calgit');
		assert.ok(extension, 'Extension should be present');
		await extension.activate();
		assert.ok(extension.isActive, 'Extension should activate');
		// attempt to open the tree view container to trigger activation
		await vscode.commands.executeCommand('workbench.view.extension.calgit');
	});
});
