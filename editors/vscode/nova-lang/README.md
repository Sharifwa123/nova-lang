# NOVA Language (VS Code extension)

Syntax highlighting for `.nova` files, plus Run/Build/Serve commands wired
into VS Code's editor toolbar, right-click menu, and Command Palette — the
same experience most language extensions give you, not just a terminal.

- **Run** (▷ button, top-right of the editor, or `Ctrl+Alt+N` / `Cmd+Alt+N`)
  → `nova run <file>`
- **Build** (editor toolbar / right-click) → `nova build <file>` (compiles
  any `PAGE` declarations to `dist/*.html`)
- **Serve** (editor toolbar / right-click) → `nova serve <file> [port]`
  (starts the live HTTP server for any `SERVICE`/`API` declarations)

All three open (or reuse) an integrated terminal named **NOVA** and run
the real CLI there — full color output, real stdin for `ASK`, `Ctrl+C` to
stop a running `nova serve`, exactly like running it by hand.

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

## What's highlighted

Every keyword through NOVA's current milestone (see the main repo's
`docs/SPECIFICATION.md`): control flow (`IF`/`FOR EACH`/`REPEAT`/`TRY`),
declarations (`DO`/`DATA`/`PAGE`/`SERVICE`/`API`), persistence/IO
(`SAVE`/`GET`/`DELETE`/`ASK`/`REQUEST`), page elements
(`TITLE`/`STYLE`/`HEADING`/`TEXT`/`BUTTON`), string interpolation
(`"Hello, {name}"`), comments (`#`), numbers, and operators. `DATA
<Name>` and `DO <name>` also get their name highlighted as a type/function,
the way most language extensions do.
