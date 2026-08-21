import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { cleanManagedSkills, DEV_SKILL_PREFIX } from './utils.js';

describe('cleanManagedSkills', () => {
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

  it('removes only the directories it manages', () => {
    seed();

    cleanManagedSkills(dir, DEV_SKILL_PREFIX);

    expect(readdirSync(dir).sort()).toEqual(['loose-file.md', 'slack-canvas', 'standup']);
    expect(existsSync(join(dir, 'slack-canvas', 'scripts', 'slack-canvas.sh'))).toBe(true);
  });

  it('leaves the containing directory in place', () => {
    seed();

    cleanManagedSkills(dir, DEV_SKILL_PREFIX);

    expect(existsSync(dir)).toBe(true);
  });

  it('creates the directory when it does not exist yet', () => {
    const missing = join(dir, 'nested', 'skills');

    cleanManagedSkills(missing, DEV_SKILL_PREFIX);

    expect(existsSync(missing)).toBe(true);
  });

  it('does not treat an empty prefix as "everything"', () => {
    seed();

    cleanManagedSkills(dir, '');

    expect(readdirSync(dir)).toHaveLength(4);
  });
});
