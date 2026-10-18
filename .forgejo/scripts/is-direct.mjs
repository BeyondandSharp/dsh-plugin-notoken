// is-direct.mjs — "is this module the process entry point?".
//
// Every shipped program ends with `if (IS_DIRECT) { … }` so the file can be
// imported by the tests without executing anything. The check compares real
// paths rather than resolved ones: /tmp is a symlink on some hosts, and
// path.resolve would then disagree with import.meta.url.
//
// It lives here because seven programs need exactly the same answer.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isDirect(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1 || !argv1.endsWith('.mjs')) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
