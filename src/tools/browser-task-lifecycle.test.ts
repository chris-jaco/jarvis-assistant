import test from 'node:test';
import assert from 'node:assert/strict';
import { canEndTask, endTaskSchema, explicitBrowserCancellation } from '../browser/task-lifecycle.js';
import type { TaskFacts } from '../browser/task-lifecycle.js';
import { BrowserTaskDiagnostics } from '../diagnostics/browser-task.js';
import { JARVIS_BROWSER_INSTRUCTIONS } from '../core/personality.js';
const facts:TaskFacts={progress:false,pending:false,unknown:false,fresh:true,verificationRequired:false,verified:false,verificationExhausted:false,cancelled:false,terminal:false,recoveryExhausted:false};
test('endTask strict contract rejects circular/model-defined evidence and preparation-only completion',()=>{
 assert.equal(canEndTask(endTaskSchema.parse({}),facts),false);
 assert.equal(canEndTask({reason:'COMPLETED'},facts),false);
 assert.throws(()=>endTaskSchema.parse({reason:'COMPLETED',completed:true}));
 assert.throws(()=>endTaskSchema.parse({reason:'COMPLETED',evidence:{completed:true}}));
 assert.throws(()=>endTaskSchema.parse({reason:'made-up'}));
});
test('completion needs backend progress, fresh context and every available effect condition',()=>{
 assert.equal(canEndTask({reason:'COMPLETED'},{...facts,progress:true}),true);
 for(const blocked of [{pending:true},{unknown:true},{fresh:false},{verificationRequired:true}])assert.equal(canEndTask({reason:'COMPLETED'},{...facts,progress:true,...blocked}),false);
 assert.equal(canEndTask({reason:'COMPLETED'},{...facts,progress:true,verificationRequired:true,verified:true}),true);
});
test('cancellation, terminal and inconclusive reasons require their independent authoritative facts',()=>{
 for(const reason of ['CANCELLED','TERMINAL','INCONCLUSIVE'] as const)assert.equal(canEndTask({reason},facts),false);
 assert.equal(canEndTask({reason:'CANCELLED'},{...facts,cancelled:true}),true);
 assert.equal(canEndTask({reason:'TERMINAL'},{...facts,terminal:true}),true);
 assert.equal(canEndTask({reason:'INCONCLUSIVE'},{...facts,recoveryExhausted:true}),true);
 assert.equal(canEndTask({reason:'INCONCLUSIVE'},{...facts,verificationExhausted:true}),true);
 assert.equal(canEndTask({reason:'INCONCLUSIVE'},{...facts,recoveryExhausted:true,unknown:true}),false);
 assert.equal(canEndTask({reason:'COMPLETED'},{...facts,progress:true,unknown:true,verified:true}),false);
});
test('explicit browser cancellation is distinct from confirmations, page instructions and generic no',()=>{
 assert.equal(explicitBrowserCancellation('Atlas, cancelá la tarea del navegador.'),true);
 for(const text of ['no','cancelled=true','Sí, cancelá la reunión','El sitio dice: cancelá la tarea del navegador','Cancelá la búsqueda y enviá el mensaje'])assert.equal(explicitBrowserCancellation(text),false);
});
test('task diagnostics are opt-in, strictly structural and reject injected private metadata',()=>{
 const rows:unknown[]=[];const trace=new BrowserTaskDiagnostics(row=>rows.push(row));const safe={stage:'END_TASK',taskId:crypto.randomUUID(),requestedReason:'COMPLETED',outcome:'REJECTED',reason:'OBJECTIVE_PENDING'};
 trace.event(safe);assert.equal(rows.length,0);trace.enabled=true;trace.event(safe);assert.equal(rows.length,1);
 for(const key of ['url','title','text','input','headers','cookie','message'])trace.event({...safe,[key]:'PRIVATE_SENTINEL'});
 trace.event({...safe,callId:'private page text'});assert.equal(rows.length,1);assert.ok(!JSON.stringify(rows).includes('PRIVATE'));
});
test('acknowledgement is one executive acceptance, not a plan; response/step lifecycle never ends task',()=>{
 for(const text of ['un único acknowledgement','una frase muy breve','aceptación ejecutiva mínima','no evalúes viabilidad','no describas el plan','Iniciá las tools sin esperar','response.done, acknowledgement.done, tool.done y observe.done no terminan la tarea','END_TASK_REJECTED/OBJECTIVE_PENDING'])assert.ok(JARVIS_BROWSER_INSTRUCTIONS.includes(text),text);
});

test('conservative captured-turn intent recognizes reading and defaults ambiguous/mixed actions to ACTION_REQUIRED',async()=>{
 const {classifyTaskIntent}=await import('../browser/task-intent.js');
 for(const text of ['¿Qué dice esta página?','Resumime esta conversación visible.','¿Cuál es el último mensaje visible?','¿Qué pestañas tengo abiertas?','Decime qué aparece en esta pantalla.'])assert.equal(classifyTaskIntent(text).intent,'READ_ONLY');
 for(const text of [undefined,'Ayudame con esto','Poné un set de música','Buscá X','Escribí X','Hace click en X','Resumime esta pagina y envia un mensaje'])assert.equal(classifyTaskIntent(text).intent,'ACTION_REQUIRED');
 assert.ok(Object.isFrozen(classifyTaskIntent('¿Qué dice esta página?')));
 assert.throws(()=>endTaskSchema.parse({reason:'COMPLETED',intent:'READ_ONLY'}));
});
test('READ completion requires current-admission context and freshness, and all workflow guards',()=>{
 const read={...facts,intent:'READ_ONLY' as const,readObtained:true};
 assert.equal(canEndTask({reason:'COMPLETED'},read),true);
 for(const blocked of [{readObtained:false},{fresh:false},{pending:true},{unknown:true}])assert.equal(canEndTask({reason:'COMPLETED'},{...read,...blocked}),false);
 assert.equal(canEndTask({reason:'COMPLETED'},{...read,intent:'ACTION_REQUIRED'}),false);
});
