// Prints a short getting-started message after `npm install -g nova-lang`.
// Silent for a local/dependency install (`npm_config_global` unset) - a
// project pulling this in as a library doesn't need a CLI banner, only
// someone installing the `nova` command itself does.
if (process.env.npm_config_global !== "true") process.exit(0);

console.log(`
NOVA installed. Get started:

  nova run yourfile.nova     run a .nova script
  nova build yourfile.nova   compile PAGE declarations to HTML
  nova serve yourfile.nova   start a live HTTP server for SERVICE/API

Language guide: https://github.com/Sharifwa123/nova-lang/blob/main/docs/LANGUAGE_GUIDE.md
`);
