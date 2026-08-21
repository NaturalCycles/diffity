import matter from 'gray-matter';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';

export interface SkillData {
  name: string;
  description: string;
  [key: string]: unknown;
}

export interface Skill {
  name: string;
  data: SkillData;
  content: string;
}

export interface TransformOptions {
  binary: string;
  namePrefix?: string;
  slashPrefix?: string;
  installHint?: string;
}

export function readSkills(sourceDir: string): Skill[] {
  const skills: Skill[] = [];
  const entries = readdirSync(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillPath = join(sourceDir, entry.name, 'SKILL.md');
    if (!existsSync(skillPath)) {
      continue;
    }

    const raw = readFileSync(skillPath, 'utf-8');
    const { data, content } = matter(raw);
    skills.push({ name: entry.name, data: data as SkillData, content });
  }

  return skills;
}

export function renderSkill(skill: Skill, { binary, namePrefix, slashPrefix, installHint }: TransformOptions): string {
  const slash = slashPrefix ?? '/diffity-';
  const hint = installHint ?? 'install it with `npm install -g diffity`';
  const body = skill.content
    .replaceAll('{{binary}}', binary)
    .replaceAll('{{slash}}', slash)
    .replaceAll('{{install_hint}}', hint);
  const data = { ...skill.data };
  if (namePrefix) {
    data.name = data.name.replace('diffity-', `${namePrefix}-`);
  }
  return matter.stringify(body, data);
}

export function writeFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

export function cleanDir(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true });
  }
  mkdirSync(dir, { recursive: true });
}

export const DEV_SKILL_PREFIX = 'diffity-dev';

// `dir` holds skills this repo does not own, so only our own prefixed entries may be removed —
// never the directory itself.
export function removePrefixedDirs(dir: string, prefix: string): string[] {
  if (!prefix) {
    throw new Error('removePrefixedDirs requires a non-empty prefix');
  }

  if (!existsSync(dir)) {
    return [];
  }

  const removed: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) {
      continue;
    }
    rmSync(join(dir, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }

  return removed;
}
