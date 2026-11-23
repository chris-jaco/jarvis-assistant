import { authorizeGoogle } from './google-onboarding.js';

try { process.loadEnvFile('.env'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
try {
  await authorizeGoogle({
    service: 'gmail', env: process.env,
    label: process.argv.slice(2).join(' ').trim() || undefined,
    openBrowser: async url => { console.log('Abrí esta URL en tu navegador local:', url); }
  });
  console.log('Autorización completada.');
} catch {
  console.error('No se completó la autorización. Revisá la configuración y el callback local.');
  process.exitCode = 1;
}
