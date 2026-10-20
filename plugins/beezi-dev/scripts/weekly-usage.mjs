import { runWeeklyUsage } from '../lib/weekly-usage.mjs';
import { exitClean } from '../lib/shutdown.mjs';

// Detached entry point. Argv carries only the account key and the workspace id to read from, never a token.
function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

// Nobody watches this process, so every path out ends in an exit, a hung socket included.
const watchdog = setTimeout(() => process.exit(0), 60_000);
const finish = () => { clearTimeout(watchdog); exitClean(0); };
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);

runWeeklyUsage({ account: argValue('--account'), tenantId: argValue('--tenant') }).then(finish, finish);
