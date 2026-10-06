import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID as id} from 'node:crypto';
import {ActionRecord,actionOutcomeSchema,outcomeInstruction} from '../browser/action-outcome.js';
import type {AttachedObservation} from '../browser/attached/protocol.js';
const observation=(playback:'PLAYING'|'PAUSED'|'UNKNOWN'='UNKNOWN'):AttachedObservation=>({tabId:id(),scopeId:id(),documentId:id(),snapshotId:id(),expiresAt:Date.now()+15000,url:'https://fixture.example/',title:'Fixture',truncated:false,elements:[],media:{presence:'AVAILABLE',playback,advertisement:'UNKNOWN',skipAvailable:false}});
test('completed + failed auto-observe, later READ failures and cancellation never erase known execution',()=>{
 const record=new ActionRecord({kind:'pause'});record.executed();record.observe({status:'FAILED',reason:'TIMEOUT'});assert.equal(record.result().outcome,'ACTION_EXECUTED_UNVERIFIED');record.unknown();record.observe({status:'FAILED',reason:'UPSTREAM'});assert.equal(record.result().execution,'EXECUTED');assert.match(outcomeInstruction(record.result()),/Nunca digas.*No pude hacerlo/);
});
test('observation OK is not verification; expected observable effect is necessary',()=>{
 const record=new ActionRecord({kind:'pause'});record.executed();record.observe({status:'OK',data:observation('PLAYING')});assert.equal(record.result().outcome,'ACTION_EXECUTED_UNVERIFIED');record.observe({status:'OK',data:observation('PAUSED')});assert.equal(record.result().outcome,'ACTION_VERIFIED');assert.equal(record.result().evidence,'PAUSED');record.observe({status:'FAILED',reason:'UPSTREAM'});assert.equal(record.result().outcome,'ACTION_VERIFIED');
 const click=new ActionRecord();click.executed();click.observe({status:'OK',data:observation('PLAYING')});assert.equal(click.result().outcome,'ACTION_EXECUTED_UNVERIFIED');
});
test('media evidence is bound to document/scope/tab; playback evidence does not verify song identity or ads',()=>{
 const data=observation('PLAYING');const record=new ActionRecord({kind:'play',documentId:data.documentId,scopeId:data.scopeId,tabId:data.tabId});record.executed();record.observe({status:'OK',data:{...data,documentId:id()}});assert.notEqual(record.result().outcome,'ACTION_VERIFIED');record.observe({status:'OK',data});assert.equal(record.result().evidence,'PLAYBACK_PLAYING');
});
test('verification has two READ attempts and no action callback; unknown is separate and cannot retry',()=>{
 const record=new ActionRecord({kind:'pause'});record.executed();assert.equal(record.claimRead(),true);assert.equal(record.claimRead(),true);assert.equal(record.claimRead(),false);const unknown=new ActionRecord();unknown.unknown();assert.equal(unknown.result().outcome,'EXECUTION_UNKNOWN');assert.equal(unknown.claimRead(),false);unknown.observe({status:'OK',data:observation('PLAYING')});assert.equal(unknown.result().outcome,'EXECUTION_UNKNOWN');assert.equal(new ActionRecord().result().outcome,'ACTION_FAILED');assert.equal(actionOutcomeSchema.safeParse({...unknown.result(),outcome:'ACTION_VERIFIED'}).success,false);
});
test('navigation verification requires the expected visible location, not merely an observation of the same origin',()=>{const record=new ActionRecord({kind:'navigation',target:'https://fixture.example/expected'});record.executed();const data=observation();record.observe({status:'OK',data});assert.equal(record.result().outcome,'ACTION_EXECUTED_UNVERIFIED');record.observe({status:'OK',data:{...data,url:'https://fixture.example/expected'}});assert.equal(record.result().outcome,'ACTION_VERIFIED');const privateQuery=new ActionRecord({kind:'navigation',target:'https://fixture.example/expected?q=example'});privateQuery.executed();privateQuery.observe({status:'OK',data:{...data,url:'https://fixture.example/expected'}});assert.notEqual(privateQuery.result().outcome,'ACTION_VERIFIED');});

test('verification without predicate is NOT_APPLICABLE and does not prohibit a distinct next step',()=>{const record=new ActionRecord();record.executed();assert.equal(record.verificationRead(),'NOT_APPLICABLE');assert.equal(record.result().step,'NOT_APPLICABLE');assert.equal(record.result().execution,'EXECUTED');assert.match(outcomeInstruction(record.result()),/siguiente paso distinto/);assert.doesNotMatch(outcomeInstruction(record.result()),/Sólo verificación READ/);});
