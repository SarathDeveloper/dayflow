import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The app uses its branded dialogs (showAlert / showConfirm in
 * components/ui/AppDialog). The browser's alert / confirm / prompt look
 * foreign, block the page, and show the site address as their title.
 */
const SRC = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('no native dialogs', () => {
  it('never calls window.alert, confirm or prompt', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const code = withoutComments(readFileSync(file, 'utf8'));
      const ownConfirm = /\b(const|let|function)\s+confirm\b/.test(code);
      const patterns = [
        /\b(window|globalThis|self)\.(alert|confirm|prompt)\s*\(/,
        /(^|[^.\w])(alert|prompt)\s*\(/m,
        ...(ownConfirm ? [] : [/(^|[^.\w])confirm\s*\(/m]),
      ];
      if (patterns.some((pattern) => pattern.test(code))) offenders.push(relative(SRC, file));
    }
    expect(offenders).toEqual([]);
  });
});
