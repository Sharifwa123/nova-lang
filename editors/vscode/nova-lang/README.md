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

## Install (no build step, zero dependencies)

This extension is plain JavaScript with no `npm install` required. Copy
(or symlink) this folder into your VS Code extensions directory, then
reload VS Code:

```bash
# macOS/Linux
cp -r editors/vscode/nova-lang ~/.vscode/extensions/nova-lang-0.1.0

# Windows (PowerShell)
Copy-Item -Recurse editors\vscode\nova-lang "$env:USERPROFILE\.vscode\extensions\nova-lang-0.1.0"
```

Then run **Developer: Reload Window** from the Command Palette (or just
restart VS Code). Open any `.nova` file and the Run/Build/Serve buttons
appear in the editor's top-right corner.

### Packaging a real .vsix (optional)

If you'd rather install it through the Extensions view like any other
extension:

```bash
npx --yes @vscode/vsce package
code --install-extension nova-lang-0.1.0.vsix
```

(`vsce` here is a one-off `npx` call for packaging only — nothing gets
added to this repository's own dependencies.)

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
