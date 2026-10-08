import { constants } from 'node:fs';
import { lstat,mkdir,open,rename,unlink } from 'node:fs/promises';
import { dirname,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TokenFileSecurity } from '../../tools/adapters/token-security.js';
import { ToolError } from '../../tools/types.js';
const rowSchema=z.object({intentId:z.string().uuid(),executionId:z.string().uuid(),state:z.enum(['RESERVED','SUCCESS','FAILURE','UNKNOWN']),updatedAt:z.number().int().positive()}).strict();
const fileSchema=z.object({version:z.literal(1),entries:z.array(rowSchema).max(10_000)}).strict();
export type JournalRow=z.infer<typeof rowSchema>;
// Only opaque IDs/state/time. Never payload, recipient, origin, credentials or approval.
export class PrivateExecutionJournal {
 readonly path:string;private tail:Promise<unknown>=Promise.resolve();private failed=false;
 constructor(path=resolve('.local/browser-consequential/journal.json'),private readonly security=new TokenFileSecurity()){this.path=resolve(path);}
 private async parents(){for(let p=dirname(this.path);;){try{if((await lstat(p)).isSymbolicLink())throw new ToolError('UNCONFIGURED');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}const next=dirname(p);if(next===p)break;p=next;}}
 private async directory(){await this.parents();const dir=dirname(this.path);const created=await mkdir(dir,{recursive:true,mode:0o700});await this.security.validate(dir,await lstat(dir),true,created!==undefined);}
 private async read(){try{await this.security.validate(this.path,await lstat(this.path));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
 const h=await open(this.path,constants.O_RDONLY|(this.security.platform==='win32'?0:constants.O_NOFOLLOW));try{await this.security.validate(this.path,await h.stat());if((await h.stat()).size>2_000_000)throw new ToolError('UNCONFIGURED');return fileSchema.parse(JSON.parse(await h.readFile('utf8'))).entries;}finally{await h.close();}}
 private async write(entries:JournalRow[]){fileSchema.parse({version:1,entries});const temporary=this.path+'.'+randomUUID()+'.tmp';let h;try{h=await open(temporary,'wx',0o600);await this.security.validate(temporary,await h.stat());await h.writeFile(JSON.stringify({version:1,entries}));await h.sync();await h.close();h=undefined;await this.parents();await this.security.validate(dirname(this.path),await lstat(dirname(this.path)),true);try{await this.security.validate(this.path,await lstat(this.path));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}await rename(temporary,this.path);
 if(this.security.platform!=='win32'){const dir=await open(dirname(this.path),constants.O_RDONLY);try{await dir.sync();}finally{await dir.close();}}
 }finally{await h?.close();await unlink(temporary).catch(e=>{if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;});}}
 private transaction<T>(work:(rows:JournalRow[])=>Promise<T>):Promise<T>{const result=this.tail.catch(()=>{}).then(async()=>{if(this.failed)throw new ToolError('UNCONFIGURED');let lock;const lockPath=this.path+'.lock';try{await this.directory();lock=await open(lockPath,'wx',0o600);await this.security.validate(lockPath,await lock.stat());return await work(await this.read());}catch{this.failed=true;throw new ToolError('UNCONFIGURED');}finally{await lock?.close();if(lock)await unlink(lockPath);}});this.tail=result;return result;}
 reserve(row:JournalRow):Promise<void>{return this.transaction(async rows=>{rowSchema.parse(row);if(rows.some(x=>x.executionId===row.executionId||x.intentId===row.intentId)||rows.length>=10_000)throw new ToolError('REJECTED');await this.write([...rows,row]);});}
 finish(executionId:string,state:'SUCCESS'|'FAILURE'|'UNKNOWN',now:number):Promise<void>{return this.transaction(async rows=>{const row=rows.find(x=>x.executionId===executionId);if(!row||row.state!=='RESERVED')throw new ToolError('REJECTED');row.state=state;row.updatedAt=now;await this.write(rows);});}
 recover():Promise<JournalRow[]>{return this.transaction(async rows=>{let changed=false;for(const row of rows)if(row.state==='RESERVED'){row.state='UNKNOWN';changed=true;}if(changed)await this.write(rows);return structuredClone(rows);});}
}
