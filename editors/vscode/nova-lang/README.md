# NOVA Language (VS Code extension)

Syntax highlighting for `.nova` files, plus Run/Build/Serve commands wired
into VS Code's editor toolbar, right-click menu, and Command Palette — the
same experience most language extensions give you, not just a terminal.

- **Run** (▷ button, top-right of the editor, or `Ctrl+Alt+N` / `Cmd+Alt+N`)
  → `nova run <file>`
- **Build** (editor toolbar / right-click) → `nova build <file>` (compiles
  any `PAGE` declarations to `dist/*.html`)
- **Serve** (editor toolbar / right-click) → `nova serve <file> <port>` —
  genuinely *live* serving: the extension polls the port with a real HTTP
  request (not a guessed delay), and once `SERVICE`/`API` is actually
  answering requests it opens your default browser to it automatically
  and shows a status bar item (`📡 NOVA :3000`) — **click the status bar
  item, or run "NOVA: Stop Server", to stop it.**

All commands open (or reuse) an integrated terminal named **NOVA** and run
the real CLI there — full color output and real stdin for `ASK` behave
exactly like running it by hand.

## Install

This extension isn't published on the VS Code Marketplace, so searching
for "NOVA" in the Extensions view's search box won't find it — that
search only reaches the public Marketplace, not this repository. Two
ways to actually install it:

### Option A — Install from VSIX (uses the Extensions tab's own UI)

1. Build the package (one-off, packaging-only — nothing gets added to
   this repository's own dependencies):
   ```bash
   cd editors/vscode/nova-lang
   npx --yes @vscode/vsce package
   ```
   This writes `nova-language-0.1.0.vsix` in that folder.
2. In VS Code, open the **Extensions** view (`Ctrl+Shift+X` /
   `Cmd+Shift+X`), click the `...` (More Actions) menu at the top of that
   panel, choose **Install from VSIX...**, and pick the `.vsix` file you
   just built.
3. Reload if prompted. Open any `.nova` file and the Run/Build/Serve
   buttons appear in the editor's top-right corner.

Equivalently, from the command line:
```bash
code --install-extension editors/vscode/nova-lang/nova-language-0.1.0.vsix
```

### Option B — Copy into your extensions folder (no build step at all)

```bash
# macOS/Linux
cp -r editors/vscode/nova-lang ~/.vscode/extensions/nova-language-0.1.0

# Windows (PowerShell)
Copy-Item -Recurse editors\vscode\nova-lang "$env:USERPROFILE\.vscode\extensions\nova-language-0.1.0"
```
Then run **Developer: Reload Window** from the Command Palette (or
restart VS Code). This won't show up in the Extensions list as an
"installed" card the way Option A does, but it works identically.

## Settings

| Setting | Default | Description |
|---|---|---|
| `nova.cliPath` | *(auto-detect)* | Absolute path to `src/cli.js`. Only needed if your `.nova` file isn't inside a NOVA checkout the extension can walk up to. |
| `nova.defaultServePort` | `3000` | Port used by **NOVA: Serve**. |
| `nova.openBrowserOnServe` | `true` | Auto-open the browser once the server is confirmed live. Set to `false` if you'd rather just watch the status bar / terminal. |

## What's highlighted

Every keyword through NOVA's current milestone (see the main repo's
`docs/SPECIFICATION.md`): control flow (`IF`/`FOR EACH`/`REPEAT`/`TRY`),
declarations (`DO`/`DATA`/`PAGE`/`SERVICE`/`API`), persistence/IO
(`SAVE`/`GET`/`DELETE`/`ASK`/`REQUEST`), page elements
(`TITLE`/`STYLE`/`HEADING`/`TEXT`/`BUTTON`), string interpolation
(`"Hello, {name}"`), comments (`#`), numbers, and operators. `DATA
<Name>` and `DO <name>` also get their name highlighted as a type/function,
the way most language extensions do.
