// NOVA VS Code extension — Run/Build/Serve commands, no external dependencies
// (plain CommonJS, only the built-in `vscode` and `node:*` modules).
"use strict";

const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const http = require("http");

let sharedTerminal = null;
let statusBarItem = null;
let serving = false;

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

// Shared preflight for all three commands: an active, saved .nova file
// and a resolved src/cli.js. Returns { filePath, cliPath } or null (after
// showing the user why).
async function prepareRun() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("NOVA: open a .nova file first.");
    return null;
  }
  const document = editor.document;
  if (document.languageId !== "nova") {
    vscode.window.showWarningMessage("NOVA: the active file isn't a .nova file.");
    return null;
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
    return null;
  }
  return { filePath, cliPath };
}

async function runSimple(command) {
  const prepared = await prepareRun();
  if (!prepared) return;
  const terminal = getTerminal();
  terminal.show();
  terminal.sendText(`node ${quote(prepared.cliPath)} ${command} ${quote(prepared.filePath)}`);
}

// Polls the port with a real HTTP request rather than guessing a fixed
// delay or parsing terminal output (VS Code's Terminal API doesn't expose
// written text without Shell Integration, which isn't guaranteed
// available) - `onReady` only fires once `nova serve` is actually
// answering requests.
function waitForServerReady(port, attemptsLeft, onReady) {
  const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 800 }, (res) => {
    res.resume(); // drain, we only care that something answered
    onReady();
  });
  req.on("error", () => {
    if (attemptsLeft <= 0) return; // give up quietly; the terminal output still shows what happened
    setTimeout(() => waitForServerReady(port, attemptsLeft - 1, onReady), 300);
  });
  req.on("timeout", () => req.destroy());
}

function showServingStatus(port) {
  serving = true;
  statusBarItem.text = `$(broadcast) NOVA :${port}`;
  statusBarItem.tooltip = "NOVA server is live - click to stop";
  statusBarItem.command = "nova.stopServe";
  statusBarItem.show();
}

function hideServingStatus() {
  serving = false;
  statusBarItem.hide();
}

async function runServe() {
  const prepared = await prepareRun();
  if (!prepared) return;

  const config = vscode.workspace.getConfiguration("nova");
  const port = config.get("defaultServePort") || 3000;

  const terminal = getTerminal();
  terminal.show();
  terminal.sendText(`node ${quote(prepared.cliPath)} serve ${quote(prepared.filePath)} ${port}`);

  waitForServerReady(port, 20, () => {
    showServingStatus(port);
    if (config.get("openBrowserOnServe")) {
      vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}/`));
    }
  });
}

function stopServe() {
  if (sharedTerminal) {
    sharedTerminal.sendText("\u0003", false); // Ctrl+C, no trailing Enter
  }
  hideServingStatus();
}

// Explorer file icons come from whichever single "File Icon Theme" is
// active - a separate VS Code extension point from language/grammar
// registration, with no API for adding an icon into someone else's
// already-active theme. The extension ships its own (contributes
// .iconThemes, package.json) so .nova files get the NOVA mark instead of
// a generic file icon, but switching the user's global icon theme is
// their call, not something to do silently - offer it once, remember
// their answer either way, and use the ordinary `workbench.iconTheme`
// setting (no private API).
async function offerNovaIconTheme(context) {
  if (context.globalState.get("novaIconThemePrompted")) return;

  const current = vscode.workspace.getConfiguration("workbench").get("iconTheme");
  if (current === "nova-icons") {
    await context.globalState.update("novaIconThemePrompted", true);
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    "NOVA: use the NOVA icon theme so .nova files show the NOVA icon in the Explorer?",
    "Enable",
    "Not now"
  );
  if (choice === "Enable") {
    await vscode.workspace
      .getConfiguration()
      .update("workbench.iconTheme", "nova-icons", vscode.ConfigurationTarget.Global);
  }
  await context.globalState.update("novaIconThemePrompted", true);
}

function activate(context) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("nova.run", () => runSimple("run")),
    vscode.commands.registerCommand("nova.build", () => runSimple("build")),
    vscode.commands.registerCommand("nova.serve", () => runServe()),
    vscode.commands.registerCommand("nova.stopServe", () => stopServe()),
    vscode.window.onDidCloseTerminal((closed) => {
      if (closed === sharedTerminal) {
        sharedTerminal = null;
        hideServingStatus();
      }
    })
  );

  offerNovaIconTheme(context);
}

function deactivate() {
  if (serving) stopServe();
}

module.exports = { activate, deactivate };
