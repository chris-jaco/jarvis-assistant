import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCimCoverage } from '../desktop/windows-process-coverage.js';
import { detectWindowsProcesses } from '../desktop/windows-process-detector.js';
import type { ProcessObservation } from '../desktop/windows-process-detector.js';
import type { CimInventory, CimProcessRecord } from '../desktop/windows-process-coverage.js';

const ticks = '134000000000000000';
const record = (overrides: Partial<CimProcessRecord> = {}): CimProcessRecord => ({
  pid: 500, creation: ticks, path: 'C:\\Windows\\System32\\example.exe', ...overrides
});
const inventory = (...records: CimProcessRecord[]): CimInventory => ({ status: 'OK', records });
const uncertain: ProcessObservation[] = [{ pid: 500, status: 'UNKNOWN' }];

test('matching PID with CIM path provides coverage without claiming physical exclusion', () => {
  const result = summarizeCimCoverage(inventory(record()), inventory(record()), uncertain, [500]);
  assert.equal(result.counts.matchedWithPath, 1);
  assert.equal(result.counts.creationStableBetweenCimSamples, 1);
  assert.equal(result.counts.win32CreationNotComparable, 1);
  assert.equal(result.diagnosticOnly, true);
  assert.equal('maintenanceAllowed' in result, false);
});
test('matching PID without CIM path remains explicitly uncovered', () => {
  const result = summarizeCimCoverage(inventory(record({ path: null })), inventory(record({ path: null })), uncertain, [500]);
  assert.equal(result.counts.matchedWithoutPath, 1);
  assert.equal(result.counts.matchedWithPath, 0);
});
test('PID reuse or contradictory dates between CIM samples prevents correlation', () => {
  const result = summarizeCimCoverage(inventory(record()), inventory(record({ creation: '134000000000000010' })), uncertain, [500]);
  assert.equal(result.counts.creationChangedBetweenCimSamples, 1);
  assert.equal(result.counts.matchedWithPath, 0);
});
test('contradiction between Win32 creation and stable CIM dates is counted', () => {
  const rows = [{ ...uncertain[0]!, creation: '134000000000000100' }];
  const result = summarizeCimCoverage(inventory(record()), inventory(record()), rows, [500]);
  assert.equal(result.counts.win32CreationConflictsWithCim, 1);
});
test('Win32 internal creation contradiction remains separate from CIM correlation', () => {
  const rows: ProcessObservation[] = [{
    pid: 500, status: 'VERIFIED', creation: ticks, verifiedCreation: '134000000000000100',
    image: { canonicalPath: 'C:\\Atlas\\Atlas.exe', volume: '12', fileId: '34' }
  }];
  assert.equal(summarizeCimCoverage(inventory(record()), inventory(record()), rows, [500]).counts.win32InternalCreationConflict, 1);
});
test('CIM microsecond precision does not create false 100-ns conflicts', () => {
  const rows = [{ ...uncertain[0]!, creation: '134000000000000009' }];
  const result = summarizeCimCoverage(inventory(record()), inventory(record()), rows, [500]);
  assert.equal(result.counts.win32CreationMatchesCim, 1);
});
test('process disappearing from CIM is coverage loss, not confirmed process termination', () => {
  const result = summarizeCimCoverage(inventory(record()), inventory(), uncertain, [500]);
  assert.equal(result.counts.presentOnlyBefore, 1);
  assert.equal('exitedConfirmed' in result.counts, false);
  assert.equal(summarizeCimCoverage(inventory(), inventory(record()), uncertain, [500]).counts.presentOnlyAfter, 1);
  assert.equal(summarizeCimCoverage(inventory(), inventory(), uncertain, [500]).counts.missingInBoth, 1);
});
test('CIM enumeration failure is never treated as an empty successful inventory', () => {
  for (const failure of [{ status: 'FAILED', records: [] }, undefined, { status: 'OK' }]) {
    const result = summarizeCimCoverage(failure, inventory(record()), uncertain, [500]);
    assert.equal(result.cimBefore.status, 'FAILED');
    assert.equal(result.correlationAvailable, false);
    assert.equal(result.counts.matchedWithPath, 0);
    assert.equal(result.counts.uncertainTotal, 1);
  }
});
test('partial creation metadata is reported as noncomparable', () => {
  for (const creation of [null, '', 'not-a-date', '0', '999999999999999999999999999']) {
    const result = summarizeCimCoverage(inventory(record({ creation })), inventory(record()), uncertain, [500]);
    assert.equal(result.counts.creationUnavailableBetweenCimSamples, 1);
    assert.equal(result.counts.win32CreationNotComparable, 1);
  }
});
test('duplicate and malformed records remain visible as ambiguous or partial coverage', () => {
  const bad = inventory(record(), record(), null as unknown as CimProcessRecord);
  const result = summarizeCimCoverage(bad, inventory(record()), uncertain, [500]);
  assert.equal(result.counts.duplicateOrAmbiguousRecord, 1);
  assert.equal(result.partialData, true);
  assert.equal(result.cimBefore.malformed, 1);
});
test('textual path difference can reflect an alias and does not establish exclusion', () => {
  const rows = [{ ...uncertain[0]!, creation: ticks, image: { canonicalPath: 'C:\\Alias\\Atlas.exe', volume: '12', fileId: '34' } }];
  const result = summarizeCimCoverage(inventory(record()), inventory(record()), rows, [500]);
  assert.equal(result.counts.pathTextDiffers, 1);
  assert.equal('excluded' in result.counts, false);
});
test('path availability changes are counted independently of identity', () => {
  const result = summarizeCimCoverage(inventory(record({ path: null })), inventory(record()), uncertain, [500]);
  assert.equal(result.counts.pathAvailabilityChanged, 1);
});
test('summary cannot leak PID, path, arguments, provider errors or arbitrary fields', () => {
  const secret = 'private-sentinel';
  const input = { ...inventory({ ...record(), path: secret }), error: secret, commandLine: secret };
  const result = summarizeCimCoverage(input, input, uncertain, [500]);
  const output = JSON.stringify(result);
  assert.equal(output.includes(secret), false);
  assert.doesNotMatch(output, /"pid"|"path"|"commandLine"|"creation"/);
  assert.equal(output.includes('500'), false);
});
test('coverage never mutates observations, uncertain PIDs or detector classification', async () => {
  const directory = { canonicalPath: 'C:\\Atlas', volume: '12', fileId: '34' };
  const executable = { canonicalPath: 'C:\\Atlas\\Atlas.exe', volume: '12', fileId: '35' };
  const identity = { directory, executable };
  const adapter = { installation: async () => identity, enumerate: async () => uncertain, verifyInstallation: async () => identity };
  const detection = await detectWindowsProcesses(adapter);
  const original = structuredClone(detection);
  const rowsBefore = structuredClone(uncertain);
  summarizeCimCoverage(inventory(record()), inventory(record()), uncertain, detection.uncertainPids);
  assert.deepEqual(detection, original);
  assert.deepEqual(uncertain, rowsBefore);
  assert.deepEqual(await detectWindowsProcesses(adapter), original);
  assert.equal(detection.state, 'INDETERMINATE');
  assert.equal(detection.maintenanceAllowed, false);
});
