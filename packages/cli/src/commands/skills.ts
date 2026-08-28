import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import pc from 'picocolors';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The dev-build skills drive a checkout's binary, not this one, so they are never touched. */
const DEV_SKILL_PREFIX = 'diffity-dev-';

function skillDirs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
}

/**
 * Copies the skills this build ships into an agent's skills directory. Every `diffity-*` directory
 * there is managed: shipped ones are replaced, ones no longer shipped are removed — a renamed skill
 * would otherwise leave its old self answering. Anything else in the directory is left alone.
 */
export function installSkills(sourceDir: string, targetDir: string): { installed: string[]; removed: string[] } {
  const shipped = skillDirs(sourceDir);
  mkdirSync(targetDir, { recursive: true });

  const removed = skillDirs(targetDir).filter(
    name => name.startsWith('diffity-') && !name.startsWith(DEV_SKILL_PREFIX) && !shipped.includes(name),
  );
  for (const name of removed) {
    rmSync(join(targetDir, name), { recursive: true, force: true });
  }

  for (const name of shipped) {
    rmSync(join(targetDir, name), { recursive: true, force: true });
    cpSync(join(sourceDir, name), join(targetDir, name), { recursive: true });
  }

  return { installed: shipped, removed };
}

export function registerSkillsCommand(program: Command, skillsHash: string): void {
  const skills = program
    .command('skills')
    .description('The agent skills this build ships');

  skills
    .command('install')
    .description('Install the skills into ~/.claude/skills. Directories named diffity-* are treated as diffity\'s and may be replaced or removed; diffity-dev-* is never touched')
    .option('--dir <path>', 'Install into this directory instead')
    .action((opts: { dir?: string }) => {
      const source = join(__dirname, 'skills');
      if (!existsSync(source) || skillDirs(source).length === 0) {
        console.error(pc.red('This build carries no skills.'));
        console.error(pc.dim('An npm install has them; a checkout needs `npm run build` first.'));
        process.exitCode = 1;
        return;
      }

      const target = opts.dir ?? join(homedir(), '.claude', 'skills');
      const { installed, removed } = installSkills(source, target);
      console.log(pc.green(`Installed ${installed.length} skills to ${target} (skills ${skillsHash})`));
      for (const name of installed) {
        console.log(pc.dim(`  ${name}`));
      }
      for (const name of removed) {
        console.log(pc.dim(`  removed ${name} — no longer shipped`));
      }
    });
}
