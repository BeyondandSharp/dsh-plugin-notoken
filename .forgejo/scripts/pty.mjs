// pty.mjs — run a command under a pseudo-terminal, without extra packages.
//
// npm only offers the web authorisation flow when BOTH stdin and stdout are
// TTYs: `otplease` in npm's lib/utils/auth.js rethrows the raw EOTP/E401 error
// (no auth URL, no doneUrl poll) as soon as `!process.stdin.isTTY ||
// !process.stdout.isTTY`, and the web-OTP branch is only reached below that
// guard. Containers have no terminal, so one is allocated with `script(1)`
// (util-linux / bsdutils; present in node:22-bookworm, installed by deps.mjs on
// Alpine via the util-linux package).
//
// The child's exit status is not read from `script`: util-linux wants `-e`,
// BusyBox does not support it, so the wrapped command writes `$?` to a file
// instead and that file is the single source of truth.

export const PTY_BIN = 'script';

/** POSIX single-quote a value so the shell reproduces it byte for byte. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * The command string handed to `script -c`: the real command, then its exit
 * code written to `exitCodeFile`. `script` runs this through `sh -c`, so `$?`
 * is the command's status and no outer shell can interfere with it.
 */
export function wrappedCommand(argv, exitCodeFile) {
  const command = argv.map(shellQuote).join(' ');
  return `${command}; printf '%s' "$?" > ${shellQuote(exitCodeFile)}`;
}

/**
 * `script(1)` arguments that make it a transparent PTY for one command.
 *
 * `-q` suppresses the "Script started/done" banner, `-c` runs the command and
 * `/dev/null` discards the session transcript; stdout/stderr of the child still
 * reach us through the PTY, which is the whole point.
 */
export function ptyArgs(command, transcript = '/dev/null') {
  return ['-q', '-c', command, transcript];
}

/** The environment npm needs to stay non-interactive inside the PTY. */
export function npmPtyEnv(env = process.env) {
  return {
    ...env,
    // Without this, open-url.js prompts "Press ENTER to open in the browser…"
    // and then tries to launch a browser: neither exists in a release runner.
    // `false` makes it print the URL and return immediately.
    npm_config_browser: 'false',
    npm_config_color: 'false',
    npm_config_progress: 'false',
    NO_COLOR: '1',
  };
}
