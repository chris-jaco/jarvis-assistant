import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { AclWorker } from './adapters/acl-worker.js';
import { ToolError } from './types.js';
const script = `const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line);process.stderr.write('private diagnostic');if(p.hang)return;if(p.exit)process.exit(1);setTimeout(()=>process.stdout.write(p.invalid?'private-output\\n':p.deny?'FAIL\\n':'OK\\r\\n'),p.delay||0)});`;
const setup = (timeout = 3000, idle = 60_000) => { let starts = 0; const worker = new AclWorker(() => { starts++; return spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] }); }, timeout, idle); return { worker, starts: () => starts }; };
const denied = (e: unknown) => e instanceof ToolError && e.category === 'UNCONFIGURED' && !e.message.includes('private');
test('ACL worker reuses transport but executes every fresh audit including changed permissions', async () => {
  const f = setup(); try {
    await Promise.all(Array.from({ length: 4 }, () => f.worker.check('{}')));
    assert.equal(f.starts(), 1);
    await assert.rejects(f.worker.check('{"deny":true}'), denied); // Warm process must not trust its previous OK.
    await f.worker.check('{}'); assert.equal(f.starts(), 1);
  } finally { f.worker.close(); }
});
test('ACL worker fails closed on unexpected output and process failure, then restarts', async () => {
  const f = setup(); try {
    await assert.rejects(f.worker.check('{"invalid":true}'), denied);
    await f.worker.check('{}'); assert.equal(f.starts(), 2);
    await assert.rejects(f.worker.check('{"exit":true}'), denied);
    await f.worker.check('{}'); assert.equal(f.starts(), 3);
  } finally { f.worker.close(); }
});
test('ACL worker cancellation stops active work; cancelled queued work cannot cancel another audit', async () => {
  const f = setup(); try {
    const queued = new AbortController(); const first = f.worker.check('{"delay":50}');
    const second = f.worker.check('{}', queued.signal); queued.abort();
    await first; await assert.rejects(second); assert.equal(f.starts(), 1);
    const active = new AbortController(); const work = f.worker.check('{"hang":true}', active.signal);
    await new Promise(resolve => setTimeout(resolve, 10)); active.abort(); await assert.rejects(work, e => e instanceof ToolError && e.category === 'TIMEOUT');
    await f.worker.check('{}'); assert.equal(f.starts(), 2);
  } finally { f.worker.close(); }
});
test('ACL worker timeout, idle shutdown and explicit close are bounded and fail safe', async () => {
  const f = setup(1000, 15); try {
    await f.worker.check('{}'); await new Promise(resolve => setTimeout(resolve, 35));
    await f.worker.check('{}'); assert.equal(f.starts(), 2);
    await assert.rejects(f.worker.check('{"hang":true}'), e => e instanceof ToolError && e.category === 'TIMEOUT');
    f.worker.close(); await assert.rejects(f.worker.check('{}'), denied);
  } finally { f.worker.close(); }
});
