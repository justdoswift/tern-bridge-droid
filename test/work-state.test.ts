import assert from 'node:assert/strict';
import test from 'node:test';
import type { BackendState, MessageBlock } from '../src/contracts.js';
import { DroidWorkTracker, isDroidWorking } from '../src/work-state.js';

function state(): BackendState {
  return {
    phase: 'idle', needsInterrupt: false, workingState: null,
    session: { id: 'first', title: 'Work', cwd: '/project', settings: { modelId: 'selected', reasoningEffort: 'high', interactionMode: 'auto', autonomyLevel: 'low' } },
    messages: [], models: [], approval: null, question: null, error: null, notice: null, context: null, usage: null,
  };
}

test('a live idle process is not active, waits pause activity, and an error cannot keep the tab working', () => {
  const data = state();
  const tracker = new DroidWorkTracker();
  assert.equal(isDroidWorking(data), false);
  assert.deepEqual(tracker.sync(data, 100), { active: false });
  data.phase = 'running'; data.needsInterrupt = true;
  assert.deepEqual(tracker.sync(data, 1000), { active: true, startedAt: 1000, stage: 'response' });
  data.phase = 'approval';
  assert.equal(isDroidWorking(data), false);
  assert.deepEqual(tracker.sync(data, 2000), { active: false });
  data.phase = 'question';
  assert.deepEqual(tracker.sync(data, 3000), { active: false });
  data.phase = 'running';
  const resumed = tracker.sync(data, 4000);
  assert.ok(resumed.active);
  assert.equal(resumed.startedAt, 1000);
  data.phase = 'error';
  assert.equal(data.needsInterrupt, true);
  assert.equal(isDroidWorking(data), false);
  assert.deepEqual(tracker.sync(data, 5000), { active: false });
});

test('tool steps use real summary metadata, update in place, and do not read ordinary output as intent', () => {
  const data = state(); data.phase = 'running';
  const tool: Extract<MessageBlock, { kind: 'tool' }> = { id: 'tool', kind: 'tool', name: 'Execute', args: JSON.stringify({ summary: 'Inspect the actual configuration', command: 'pwd' }), output: 'Not a step title', status: 'running' };
  data.messages = [{ id: 'u', role: 'user', blocks: [{ id: 'u:0', kind: 'text', text: 'Inspect' }] }, { id: 'a', role: 'assistant', blocks: [tool] }];
  const tracker = new DroidWorkTracker();
  const first = tracker.sync(data, 10);
  assert.ok(first.active);
  assert.equal(first.step, 'Inspect the actual configuration');
  tool.args = '{partial';
  const partial = tracker.sync(data, 20);
  assert.ok(partial.active);
  assert.equal(partial.step, 'Execute');
  tool.args = JSON.stringify({ summary: 'Run focused verification' });
  const next = tracker.sync(data, 30);
  assert.ok(next.active);
  assert.equal(next.step, 'Run focused verification');
  assert.equal(next.startedAt, 10);
});

test('new turns and sessions reset the observation clock rather than reusing historical elapsed time or intent', () => {
  const data = state(); data.phase = 'running';
  const tracker = new DroidWorkTracker();
  const first = tracker.sync(data, 100);
  assert.ok(first.active);
  data.phase = 'stopping';
  const stopping = tracker.sync(data, 200);
  assert.ok(stopping.active);
  assert.equal(stopping.startedAt, 100);
  assert.equal(stopping.stage, 'stopping');
  data.phase = 'idle';
  tracker.sync(data, 300);
  data.phase = 'running';
  const second = tracker.sync(data, 400);
  assert.ok(second.active);
  assert.equal(second.startedAt, 400);
  data.session = { ...data.session!, id: 'successor' };
  const successor = tracker.sync(data, 500);
  assert.ok(successor.active);
  assert.equal(successor.startedAt, 500);
  data.session = null;
  assert.equal(isDroidWorking(data), false);
  assert.deepEqual(tracker.sync(data, 600), { active: false });
});

test('only actually streaming thinking selects the thinking step; restored thinking is not running work', () => {
  const data = state();
  data.messages = [{ id: 'restored', role: 'assistant', blocks: [{ id: 'thought', kind: 'thinking', text: 'Historical reasoning' }] }];
  const tracker = new DroidWorkTracker();
  assert.deepEqual(tracker.sync(data, 1), { active: false });
  data.phase = 'running';
  let work = tracker.sync(data, 2);
  assert.ok(work.active);
  assert.equal(work.stage, 'response');
  data.messages[0]!.streaming = true;
  work = tracker.sync(data, 3);
  assert.ok(work.active);
  assert.equal(work.stage, 'thinking');
});

test('the current reply replaces a settled tool step without exposing tool output or reasoning', () => {
  const data = state(); data.phase = 'running';
  const tool: Extract<MessageBlock, { kind: 'tool' }> = {
    id: 'tool', kind: 'tool', name: 'Execute', args: JSON.stringify({ summary: 'Inspect configuration' }),
    output: 'Tool output is not the working label', status: 'running',
  };
  const message = { id: 'a', role: 'assistant' as const, blocks: [tool] as MessageBlock[], streaming: true };
  data.messages = [{ id: 'u', role: 'user', blocks: [{ id: 'u:0', kind: 'text', text: 'Inspect' }] }, message];
  const tracker = new DroidWorkTracker();
  const running = tracker.sync(data, 100);
  assert.ok(running.active);
  assert.equal(running.step, 'Inspect configuration');
  tool.status = 'done'; tool.resultReceived = true;
  const settled = tracker.sync(data, 200);
  assert.ok(settled.active);
  assert.equal(settled.stage, 'response');
  assert.equal(settled.step, undefined);
  message.blocks.push({ id: 'a:1', kind: 'text', text: '\nNow checking the result.\nAdditional explanation.' });
  const reply = tracker.sync(data, 300);
  assert.ok(reply.active);
  assert.equal(reply.step, 'Now checking the result.');
  assert.equal(reply.startedAt, 100);
  message.blocks[1] = { id: 'a:1', kind: 'text', text: 'The result is ready.' };
  const updated = tracker.sync(data, 400);
  assert.ok(updated.active);
  assert.equal(updated.step, 'The result is ready.');
  message.blocks.push({ id: 'a:2', kind: 'thinking', text: 'Do not use reasoning as a status title' });
  const thinking = tracker.sync(data, 500);
  assert.ok(thinking.active);
  assert.equal(thinking.stage, 'thinking');
  assert.equal(thinking.step, undefined);
  data.messages.push({ id: 'next', role: 'user', blocks: [{ id: 'next:0', kind: 'text', text: 'Next task' }] });
  const next = tracker.sync(data, 600);
  assert.ok(next.active);
  assert.equal(next.stage, 'response');
  assert.equal(next.step, undefined);
  data.messages = [{ id: 'restored-reply', role: 'assistant', blocks: [{ id: 'restored:0', kind: 'text', text: 'An earlier completed reply' }] }];
  const beforeAcceptance = tracker.sync(data, 700);
  assert.ok(beforeAcceptance.active);
  assert.equal(beforeAcceptance.step, undefined);
});
