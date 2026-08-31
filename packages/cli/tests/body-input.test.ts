import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveBodyText } from '../src/agent.js';

describe('where a body comes from', () => {
  it('argv arrives exactly as typed — discussing escapes never mangles them', () => {
    expect(resolveBodyText({ body: "why not split('\\n')? the \\\" is deliberate" }))
      .toBe("why not split('\\n')? the \\\" is deliberate");
  });

  it('a file sheds exactly one trailing newline, the artifact of every heredoc', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diffity-body-'));
    try {
      const file = join(dir, 'body.md');
      writeFileSync(file, 'line one\n\nline `three`\n');
      expect(resolveBodyText({ bodyFile: file })).toBe('line one\n\nline `three`');

      writeFileSync(file, 'kept blank line\n\n');
      expect(resolveBodyText({ bodyFile: file })).toBe('kept blank line\n');

      writeFileSync(file, 'written on windows\r\n');
      expect(resolveBodyText({ bodyFile: file })).toBe('written on windows');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('"-" means stdin', () => {
    const readFrom: (string | 0)[] = [];
    const read = (path: string | 0) => {
      readFrom.push(path);
      return 'from stdin\n';
    };

    expect(resolveBodyText({ bodyFile: '-' }, read)).toBe('from stdin');
    expect(readFrom).toEqual([0]);
  });

  it('refuses to guess between two sources', () => {
    expect(() => resolveBodyText({ body: 'a', bodyFile: 'b.md' }))
      .toThrowError('Use --body or --body-file, not both');
  });

  it('an unreadable file says which one, and why', () => {
    expect(() => resolveBodyText({ bodyFile: '/nowhere/nothing.md' }))
      .toThrowError(/Could not read "\/nowhere\/nothing\.md": .*ENOENT/);
  });

  it('absent everywhere is null, for the options that default instead of requiring', () => {
    expect(resolveBodyText({})).toBeNull();
  });
});
