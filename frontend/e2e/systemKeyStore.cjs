/**
 * Loaded into the app's main process ahead of the app (`-r`, after Playwright's own loader) when launch()
 * is asked for the system key store. Playwright starts every Electron app with the switches it uses for
 * automated browsers, among them `--password-store=basic` and `--use-mock-keychain`: safeStorage then
 * encrypts with a fixed password (Linux) or a mock keychain (macOS) and never with the store a person's
 * app uses. Removing the two switches before the app starts lets it read keys a person's app stored.
 *
 * It takes itself out of process.argv again, so the app sees the arguments it would see without it.
 */
// A module loaded with -r is CommonJS: Node requires it before any ES module loader exists.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { app } = require('electron')

app.commandLine.removeSwitch('password-store')
app.commandLine.removeSwitch('use-mock-keychain')

const at = process.argv.indexOf(__filename)
if (at > 0 && ['-r', '--require'].includes(process.argv[at - 1])) process.argv.splice(at - 1, 2)
