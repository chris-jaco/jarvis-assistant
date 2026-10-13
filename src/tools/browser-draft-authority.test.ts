import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exactDraftContent,exactDraftClarification,incidentalAcknowledgement } from '../browser/draft-authority.js';

test('exact draft authority preserves case, punctuation, spaces, and Unicode',()=>{
  const text='Átlas  TEST — mañana,  08:00 ✅';
  assert.deepEqual(exactDraftContent(`Escribí en WhatsApp. Texto exacto: ${text} fin del mensaje.`),{status:'EXACT',text});
  assert.deepEqual(exactDraftContent('Write this exact message: Hello,  WORLD! end message'),{status:'EXACT',text:'Hello,  WORLD!'});
  assert.deepEqual(exactDraftClarification('Exact message: Texto exacto — sin normalizar end message'),{status:'EXACT',text:'Texto exacto — sin normalizar'});
});

test('ambiguous transcript never becomes draft authority',()=>{
  assert.deepEqual(exactDraftContent('Write a WhatsApp draft with: Atlas test V2. Do not send it.'),{status:'AMBIGUOUS'});
  assert.deepEqual(exactDraftContent('texto exacto: falta el delimitador'),{status:'AMBIGUOUS'});
  assert.deepEqual(exactDraftContent('“uno” y “dos”'),{status:'AMBIGUOUS'});
  assert.deepEqual(exactDraftClarification('Nueva tarea. Exact message: secreto end message'),{status:'AMBIGUOUS'});
});

test('only narrow acknowledgements are incidental',()=>{
  for(const text of ['Sí','Dale.','OK','Да','continue'])assert.equal(incidentalAcknowledgement(text),true);
  for(const text of ['Escribí otro mensaje','Cambialo por otro texto','Sí, pero usá otra conversación'])assert.equal(incidentalAcknowledgement(text),false);
});
