import { GmailAccountStore, accountIdSchema } from '../tools/adapters/gmail-accounts.js';
try { process.loadEnvFile('.env'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
const store = new GmailAccountStore();
try {
  const args = process.argv.slice(2);
  if (!args.length) console.log(JSON.stringify(await store.list(), null, 2));
  else if (args.length === 2 && args[0] === '--remove') { await store.remove(accountIdSchema.parse(args[1])); console.log('Cuenta desconectada localmente. Revocá también el acceso en tu cuenta Google si no lo necesitás.'); }
  else throw new Error();
} catch { console.error('No se pudieron consultar/desconectar las cuentas. Revisá la configuración y los permisos de almacenamiento.'); process.exitCode = 1; }
