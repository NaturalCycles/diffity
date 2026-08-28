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
  const hint = installHint ?? 'install it with `npm install -g @naturalcycles/diffity` and run `diffity skills install`';
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

// Remove only the skill directories diffity manages (those named `${prefix}-*`),
// leaving any other skills in the directory untouched. Unlike cleanDir, this is
// safe to run against a shared location like ~/.claude/skills, which may hold
// the user's own skills or skills installed by other tools.
export function cleanManagedSkills(dir: string, prefix: string): void {
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(`${prefix}-`)) {
      rmSync(join(dir, entry.name), { recursive: true, force: true });
    }
  }
}
