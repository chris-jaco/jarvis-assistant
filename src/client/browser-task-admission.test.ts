import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserTaskAdmission } from '../provider/browser-task-admission.js';
test('admission binds actual captured speech, waits boundedly for ASR and freezes after dispatch',async()=>{
 const a=new BrowserTaskAdmission();a.begin('turn');const waiting=a.request(100);a.capture('old','Resumime esta pagina');a.capture('turn','¿Qué dice esta página?');const payload=await waiting;assert.equal(payload?.userTurn?.utterance,'¿Qué dice esta página?');a.capture('turn','Buscá X');assert.equal(await a.request(0),undefined);
});
test('missing, late and unrelated transcripts default to action without importing another user turn',async()=>{
 const a=new BrowserTaskAdmission();a.begin('turn');a.capture('other','¿Qué dice esta página?');const payload=await a.request(1);assert.ok(payload?.admissionId);assert.equal(payload.userTurn,undefined);a.capture('turn','¿Qué dice esta página?');assert.equal(await a.request(0),undefined);
 a.begin('old');const waiting=a.request(100);a.begin('new');assert.equal(await waiting,undefined);a.capture('new','Buscá X');assert.equal((await a.request(0))?.userTurn?.utterance,'Buscá X');
});
