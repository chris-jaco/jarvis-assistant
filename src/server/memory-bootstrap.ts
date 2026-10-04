import { createMemoryRuntime } from '../memory/runtime.js';
import { MemoryAdapter } from '../memory/adapter.js';
import { ToolRegistry } from '../tools/registry.js';
import { ToolExecutor } from '../tools/execution.js';
import { candidateSchema } from '../memory/types.js';
import { z } from 'zod';
try { process.loadEnvFile('.env'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
// Read reviewed candidates via stdin. No shipped personal default or CLI secret.
try {
  let data = ''; for await (const chunk of process.stdin) { data += String(chunk); if (data.length > 16_000) throw new Error(); }
  const candidates = z.array(candidateSchema).min(1).max(8).parse(JSON.parse(data));
  const memory = createMemoryRuntime(); const registry = new ToolRegistry(); registry.add(new MemoryAdapter(memory.service));
  const executor = new ToolExecutor(registry);
  try {
    for (const [index, candidate] of candidates.entries()) {
      const result = await executor.invoke('bootstrap-' + index, 'memory.ingest', { candidate, source: { kind: 'explicit_user', evidence: candidate.content, observedAt: new Date().toISOString() } });
      if (result.status !== 'success' || !(result.data as { remembered?: boolean }).remembered) throw new Error();
    }
    console.log('Preferencias revisadas guardadas.');
  } finally { executor.close(); }
} catch { console.error('No se pudo completar el bootstrap. No se muestran datos privados; revisa el formato y permisos.'); process.exitCode = 1; }
