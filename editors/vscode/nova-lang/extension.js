// NOVA VS Code extension — Run/Build/Serve commands, no external dependencies
// (plain CommonJS, only the built-in `vscode` and `node:*` modules).
"use strict";

const vscode = require("vscode");
const path = require("path");
const fs = require("fs");

let sharedTerminal = null;

function getTerminal() {
  if (sharedTerminal && vscode.window.terminals.includes(sharedTerminal)) {
    return sharedTerminal;
  }
  sharedTerminal = vscode.window.createTerminal("NOVA");
  return sharedTerminal;
}

// Walks up from `startDir` looking for a folder containing `src/cli.js`
// (NOVA's own layout, README.md "Layout" section) - this is how the
// extension finds the interpreter without the user having to configure
// anything, as long as the .nova file lives inside (or under) a NOVA
// checkout.
function findCliPath(startDir) {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, "src", "cli.js");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveCliPath(fileDir) {
  const configured = vscode.workspace.getConfiguration("nova").get("cliPath");
  if (configured && configured.trim().length > 0) {
    return configured.trim();
  }
  return findCliPath(fileDir);
}

// Quotes a path for a shell command line - handles spaces on both
// POSIX shells and PowerShell/cmd (double quotes work on all three).
function quote(p) {
  return `"${p}"`;
}

async function runNovaCommand(command, { needsPort = false } = {}) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("NOVA: open a .nova file first.");
    return;
  }
  const document = editor.document;
  if (document.languageId !== "nova") {
    vscode.window.showWarningMessage("NOVA: the active file isn't a .nova file.");
    return;
  }
  if (document.isDirty) {
    await document.save();
  }

  const filePath = document.uri.fsPath;
  const cliPath = resolveCliPath(path.dirname(filePath));
  if (!cliPath) {
    vscode.window.showErrorMessage(
      "NOVA: couldn't find src/cli.js. Set the \"nova.cliPath\" setting to your NOVA checkout's src/cli.js."
    );
    return;
  }

  let commandLine = `node ${quote(cliPath)} ${command} ${quote(filePath)}`;
  if (needsPort) {
    const port = vscode.workspace.getConfiguration("nova").get("defaultServePort") || 3000;
    commandLine += ` ${port}`;
  }

  const terminal = getTerminal();
  terminal.show();
  terminal.sendText(commandLine);
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("nova.run", () => runNovaCommand("run")),
    vscode.commands.registerCommand("nova.build", () => runNovaCommand("build")),
    vscode.commands.registerCommand("nova.serve", () => runNovaCommand("serve", { needsPort: true }))
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
