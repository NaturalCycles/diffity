import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { removePrefixedDirs, DEV_SKILL_PREFIX } from './utils.js';

describe('removePrefixedDirs', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'diffity-skills-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(): void {
    mkdirSync(join(dir, `${DEV_SKILL_PREFIX}-review`), { recursive: true });
    writeFileSync(join(dir, `${DEV_SKILL_PREFIX}-review`, 'SKILL.md'), 'dev skill');
    mkdirSync(join(dir, 'slack-canvas', 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'slack-canvas', 'scripts', 'slack-canvas.sh'), '#!/bin/sh');
    mkdirSync(join(dir, 'standup'), { recursive: true });
    writeFileSync(join(dir, 'loose-file.md'), 'not a skill');
  }

  it('removes only directories matching the prefix', () => {
    seed();

    const removed = removePrefixedDirs(dir, DEV_SKILL_PREFIX);

    expect(removed).toEqual([`${DEV_SKILL_PREFIX}-review`]);
    expect(readdirSync(dir).sort()).toEqual(['loose-file.md', 'slack-canvas', 'standup']);
    expect(existsSync(join(dir, 'slack-canvas', 'scripts', 'slack-canvas.sh'))).toBe(true);
  });

  it('leaves the containing directory in place', () => {
    seed();

    removePrefixedDirs(dir, DEV_SKILL_PREFIX);

    expect(existsSync(dir)).toBe(true);
  });

  it('returns nothing when the directory does not exist', () => {
    expect(removePrefixedDirs(join(dir, 'missing'), DEV_SKILL_PREFIX)).toEqual([]);
  });

  it('rejects an empty prefix instead of removing everything', () => {
    seed();

    expect(() => removePrefixedDirs(dir, '')).toThrow(/non-empty prefix/);
    expect(readdirSync(dir)).toHaveLength(4);
  });
});
