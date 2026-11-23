import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { validGoogleClientId, validGoogleClientSecret, type GoogleClientCredentials } from './core-bootstrap-protocol.js';

const installedClient = z.object({
  installed: z.object({
    client_id: z.string().refine(validGoogleClientId),
    client_secret: z.string().refine(validGoogleClientSecret),
    project_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u),
    auth_uri: z.literal('https://accounts.google.com/o/oauth2/auth'),
    token_uri: z.literal('https://oauth2.googleapis.com/token'),
    auth_provider_x509_cert_url: z.literal('https://www.googleapis.com/oauth2/v1/certs').optional(),
    redirect_uris: z.array(z.string().regex(/^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?(\/oauth\/callback|\/)?$/u)).min(1).max(8)
  }).strict()
}).strict();
const limit = 32 * 1024;

export async function importGoogleClient(select: () => Promise<string | undefined>, store: (pair: GoogleClientCredentials) => Promise<void>) {
  const path = await select();
  if (!path) return 'CANCELLED';
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
    const info = await handle.stat();
    if (!info.isFile() || !info.size || info.size > limit) throw new Error();
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    try {
      while (total < buffer.length) {
        const read = await handle.read(buffer, total, buffer.length - total);
        if (!read.bytesRead) break;
        total += read.bytesRead;
      }
      if (total !== info.size) throw new Error();
      const { installed } = installedClient.parse(JSON.parse(buffer.toString('utf8', 0, total).replace(/^\uFEFF/u, '')));
      await store({ GOOGLE_CLIENT_ID: installed.client_id, GOOGLE_CLIENT_SECRET: installed.client_secret });
    } finally { buffer.fill(0); }
    return 'IMPORTED';
  } catch { throw new Error('GOOGLE_IMPORT_FAILED'); }
  finally { await handle?.close(); }
}
