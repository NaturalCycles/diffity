import type { Command } from 'commander';
import { rmSync, existsSync } from 'node:fs';
import pc from 'picocolors';
import { diffityDir, readRegistry } from '../registry.js';

export function registerPruneCommand(program: Command) {
  program
    .command('prune')
    .description('Remove all diffity data (database, sessions) for all repos')
    .action(() => {
      const dir = diffityDir();
      if (!existsSync(dir)) {
        console.log(pc.dim('Nothing to prune.'));
        return;
      }

      const running = readRegistry();
      for (const entry of running) {
        try {
          process.kill(entry.pid, 'SIGTERM');
        } catch {}
      }
      if (running.length > 0) {
        console.log(pc.dim(`  Stopped ${running.length} running instance${running.length > 1 ? 's' : ''}.`));
      }

      rmSync(dir, { recursive: true, force: true });
      console.log(pc.green(`Pruned all diffity data (${dir}).`));
    });
}
