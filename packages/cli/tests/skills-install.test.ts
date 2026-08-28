import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installSkills } from '../src/commands/skills.js';

let root: string;

function skill(dir: string, name: string, content = `# ${name}\n`): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'diffity-skills-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('installSkills', () => {
  it('copies every shipped skill, replacing what was there', () => {
    const source = join(root, 'source');
    const target = join(root, 'target');
    skill(source, 'diffity-review', 'new wording\n');
    skill(source, 'diffity-live');
    skill(target, 'diffity-review', 'old wording\n');

    const { installed } = installSkills(source, target);

    expect(installed.sort()).toEqual(['diffity-live', 'diffity-review']);
    expect(readFileSync(join(target, 'diffity-review', 'SKILL.md'), 'utf-8')).toBe('new wording\n');
    expect(existsSync(join(target, 'diffity-live', 'SKILL.md'))).toBe(true);
  });

  it('removes a managed skill that is no longer shipped, and nothing else', () => {
    const source = join(root, 'source');
    const target = join(root, 'target');
    skill(source, 'diffity-review');
    skill(target, 'diffity-renamed-away');
    skill(target, 'diffity-dev-review');
    skill(target, 'somebody-elses-skill');

    const { removed } = installSkills(source, target);

    expect(removed).toEqual(['diffity-renamed-away']);
    expect(existsSync(join(target, 'diffity-renamed-away'))).toBe(false);
    expect(existsSync(join(target, 'diffity-dev-review'))).toBe(true);
    expect(existsSync(join(target, 'somebody-elses-skill'))).toBe(true);
  });

  it('creates the target directory when none exists', () => {
    const source = join(root, 'source');
    skill(source, 'diffity-review');

    const { installed } = installSkills(source, join(root, 'not', 'yet', 'there'));

    expect(installed).toEqual(['diffity-review']);
  });
});
