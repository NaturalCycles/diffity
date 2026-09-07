import type { Command } from 'commander';
import pc from 'picocolors';
import { isCliInstalled, isAuthenticated } from '@diffity/github';
import { loadInboxConfig } from '../inbox/config.js';
import { inboxConfigPath, inboxStorePath } from '../inbox/paths.js';
import { InboxStore } from '../inbox/store.js';
import { runDaemon } from '../inbox/daemon.js';
import { allowFromEnv, mcpGateDecision } from '../inbox/mcp-gate.js';
import { buildView } from '../inbox/view.js';

export function registerInboxCommand(program: Command): void {
  const inbox = program
    .command('inbox')
    .description('Watch the pull requests awaiting your review and prepare them ahead of time')
    .option('--once', 'Run a single poll-and-prepare pass, then exit')
    .option('--config <path>', 'Config file to use instead of the default')
    .action(async (opts: { once?: boolean; config?: string }) => {
      if (!isCliInstalled()) {
        console.error(pc.red('Error: GitHub CLI (gh) is not installed.'));
        process.exit(1);
      }
      if (!isAuthenticated()) {
        console.error(pc.red('Error: Not authenticated with GitHub CLI. Run `gh auth login`.'));
        process.exit(1);
      }

      const configPath = opts.config ?? inboxConfigPath();
      let config;
      try {
        config = loadInboxConfig(configPath);
      } catch (err) {
        console.error(pc.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }

      const store = new InboxStore(inboxStorePath());
      const entry = process.argv[1];
      const log = (message: string) => console.log(`${pc.dim(new Date().toLocaleTimeString())} ${message}`);

      if (opts.once) {
        await runDaemon(store, config, process.execPath, entry, log, { once: true });
        return;
      }

      // Armed before the first tick, which may be the longest one: Ctrl-C during it should stop
      // cleanly rather than hard-exit and orphan a preparation.
      let handleStop: (() => Promise<void>) | null = null;
      const shutdown = () => {
        (handleStop ? handleStop() : Promise.resolve()).then(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      console.log(pc.green(`📋 diffity inbox on http://localhost:${config.port} — polling every ${config.pollMinutes} min. Ctrl-C to stop.`));
      const handle = await runDaemon(store, config, process.execPath, entry, log, { configPath });
      handleStop = handle.stop;
    });

  // Not for a person to run: this is the PreToolUse hook the daemon puts in the review agent's
  // settings, and it answers on its exit code — 0 lets the call through, 2 refuses it.
  inbox
    .command('mcp-gate', { hidden: true })
    .description('Allow only the MCP tools named in DIFFITY_MCP_ALLOW')
    .action(async () => {
      const decision = mcpGateDecision(await readJsonStdin(), allowFromEnv(process.env.DIFFITY_MCP_ALLOW));
      if (decision.allow) {
        return;
      }
      console.error(decision.message);
      process.exit(2);
    });

  inbox
    .command('status')
    .description('Print the current inbox without starting the daemon')
    .option('--json', 'Output as JSON')
    .option('--config <path>', 'Config file to use instead of the default')
    .action((opts: { json?: boolean; config?: string }) => {
      const config = loadInboxConfig(opts.config ?? inboxConfigPath());
      const store = new InboxStore(inboxStorePath());
      const view = buildView(store, `http://localhost:${config.port}`, new Date().toISOString());
      store.close();

      if (opts.json) {
        console.log(JSON.stringify(view, null, 2));
        return;
      }

      if (view.ready.length === 0 && view.working.length === 0 && view.other.length === 0 && view.dismissed.length === 0) {
        console.log(pc.dim('Nothing in the inbox yet. Run `diffity inbox` to start watching.'));
        return;
      }

      section('Ready to review', view.ready.map(row =>
        `  ${sizeBadge(row)} ${pc.bold(`${row.repo}#${row.number}`)} ${row.title}${row.summary ? pc.dim(`  ${row.summary}`) : ''}${row.alert ? pc.red(`  ⚠ ${row.alert}`) : ''}${row.stale ? pc.yellow('  (stale — new commits)') : ''}`,
      ));
      section('Queue', view.working.map(row =>
        `  ${pc.dim(row.status.padEnd(9))} ${row.repo}#${row.number} ${row.title} ${pc.dim(row.statusReason ?? '')}`,
      ));
      section('Other', view.other.map(row =>
        `  ${pc.dim(row.status.padEnd(9))} ${row.repo}#${row.number} ${pc.dim(row.statusReason ?? '')}`,
      ));
      section('Dismissed', view.dismissed.map(row =>
        `  ${pc.dim('dismissed')} ${row.repo}#${row.number} ${row.title}`,
      ));
    });
}

/** All of stdin, parsed; unparseable input reads as null, which the gate refuses. */
async function readJsonStdin(): Promise<unknown> {
  let raw = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function section(title: string, lines: string[]): void {
  if (lines.length === 0) {
    return;
  }
  console.log('');
  console.log(pc.dim(title));
  for (const line of lines) {
    console.log(line);
  }
}

function sizeBadge(row: { additions: number; deletions: number }): string {
  return pc.dim(`+${row.additions}/-${row.deletions}`.padEnd(12));
}
