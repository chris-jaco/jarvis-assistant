import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserTaskAdmission } from '../provider/browser-task-admission.js';
test('admission binds actual captured speech, waits boundedly for ASR and freezes after dispatch',async()=>{
 const a=new BrowserTaskAdmission();a.begin('turn');const waiting=a.request(100);a.capture('old','Resumime esta pagina');a.capture('turn','¿Qué dice esta página?');const payload=await waiting;assert.equal(payload?.userTurn?.utterance,'¿Qué dice esta página?');a.capture('turn','Buscá X');assert.equal(await a.request(0),undefined);
});
test('missing transcript is marked pending and only the exact original item may enrich that admission late',async()=>{
 const a=new BrowserTaskAdmission();a.begin('turn');a.capture('other','¿Qué dice esta página?');const payload=await a.request(1);assert.ok(payload?.admissionId);assert.equal(payload.userTurn,undefined);assert.equal(await a.request(0),undefined);
 assert.equal(payload.transcriptPending,true);const late=a.capture('turn','¿Qué dice esta página?');assert.equal(late?.admissionId,payload.admissionId);assert.equal(late?.userTurn.utterance,'¿Qué dice esta página?');assert.equal(late?.late,true);assert.equal(a.capture('turn','Buscá X'),undefined);
 a.begin('old');const waiting=a.request(100);a.begin('new');assert.equal(await waiting,undefined);a.capture('new','Buscá X');assert.equal((await a.request(0))?.userTurn?.utterance,'Buscá X');
});
test('a new turn clears late admission authority from the prior item',async()=>{
 const a=new BrowserTaskAdmission();a.begin('old');await a.request(1);a.begin('new');assert.equal(a.capture('old','Escribí un mensaje'),undefined);a.capture('new','Prepará un borrador privado');assert.equal((await a.request(0))?.userTurn?.utterance,'Prepará un borrador privado');
});
test('late enrichment authority expires instead of retaining a continuation forever',async()=>{
 let now=1_000;const a=new BrowserTaskAdmission(()=>now,25);a.begin('turn');const payload=await a.request(0);assert.equal(payload?.transcriptPending,true);now+=26;assert.equal(a.capture('turn','Escribí el mensaje en WhatsApp'),undefined);
});
