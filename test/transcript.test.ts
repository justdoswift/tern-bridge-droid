import assert from 'node:assert/strict';
import test from 'node:test';
import { Transcript } from '../src/transcript.js';

const assistant = { id: 'assistant-real-id', role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] };

test('deltas, completion and persisted final message reconcile once under the real message ID', () => {
  const transcript = new Transcript();
  transcript.apply({ type: 'assistant_text_delta', messageId: assistant.id, blockIndex: 0, textDelta: 'Hello ' });
  transcript.apply({ type: 'assistant_text_delta', messageId: assistant.id, blockIndex: 0, textDelta: 'world' });
  transcript.apply({ type: 'assistant_text_complete', messageId: assistant.id, blockIndex: 0 });
  transcript.apply({ type: 'create_message', message: assistant });
  transcript.apply({ type: 'create_message', message: assistant });
  transcript.apply({ type: 'assistant_text_delta', messageId: assistant.id, blockIndex: 0, textDelta: 'late duplicate' });
  assert.deepEqual(transcript.messages, [{ id: assistant.id, role: 'assistant', blocks: [{ id: `${assistant.id}:0`, kind: 'text', text: 'Hello world' }] }]);
});

test('restored messages keep tool IDs and results, visible thinking, documents and errors without exposing redacted thinking', () => {
  const transcript = new Transcript();
  transcript.hydrate([
    { id: 'user', role: 'user', content: [{ type: 'text', text: 'Inspect' }] },
    { id: 'private', role: 'user', visibility: 'llm_only', content: [{ type: 'text', text: 'internal prompt' }] },
    { id: 'assistant', role: 'assistant', content: [
      { type: 'thinking', thinking: 'Actually provided reasoning', signature: 'never display signature' },
      { type: 'redacted_thinking', data: 'never display redaction payload' },
      { type: 'tool_use', id: 'exact-tool-id', name: 'Execute', input: { command: 'pwd' } },
    ] },
    { id: 'result', role: 'user', content: [{ type: 'tool_result', toolUseId: 'exact-tool-id', content: 'Permission denied', isError: true }] },
    { id: 'document', role: 'user', content: [{ type: 'document', source: { type: 'text', data: 'Attached text' } }] },
    { id: 'error-message', role: 'assistant', isError: true, content: [{ type: 'text', text: 'The operation failed.' }] },
  ]);
  assert.deepEqual(transcript.messages.map(message => message.id), ['user', 'assistant', 'document', 'error-message']);
  const tool = transcript.messages[1]?.blocks.find(block => block.kind === 'tool');
  assert.equal(tool?.id, 'exact-tool-id');
  assert.ok(tool?.kind === 'tool');
  assert.equal(tool.output, 'Permission denied');
  assert.equal(tool.status, 'error');
  assert.equal(transcript.messages[1]?.blocks[0]?.kind, 'thinking');
  assert.doesNotMatch(JSON.stringify(transcript.messages), /never display|internal prompt/);
  assert.match(JSON.stringify(transcript.messages), /Attached text|The operation failed/);
});

test('tool progress before its owning message reconciles by exact tool ID and final output replaces progress', () => {
  const transcript = new Transcript();
  transcript.apply({ type: 'tool_call', toolUse: { id: 'tool', name: 'Execute', input: { command: 'pwd' } } });
  transcript.apply({ type: 'tool_progress_update', toolUseId: 'tool', toolName: 'Execute', update: { type: 'message', text: 'partial' } });
  assert.equal(transcript.messages.length, 0, 'no invented assistant message identity');
  transcript.apply({ type: 'create_message', message: { id: 'real-owner', role: 'assistant', content: [{ type: 'tool_use', id: 'tool', name: 'Execute', input: { command: 'pwd' } }] } });
  const tool = transcript.messages[0]?.blocks[0];
  assert.ok(tool?.kind === 'tool');
  assert.equal(tool.output, 'partial');
  transcript.apply({ type: 'tool_progress_update', toolUseId: 'tool', toolName: 'Execute', update: { type: 'message', fullOutput: 'complete snapshot' } });
  transcript.apply({ type: 'tool_result', toolUseId: 'tool', messageId: 'persisted-result', content: 'final output' });
  assert.equal(tool.output, 'final output');
  assert.equal(tool.status, 'done');
  transcript.apply({ type: 'create_message', message: { id: 'real-owner', role: 'assistant', content: [{ type: 'tool_use', id: 'tool', name: 'Execute', input: { command: 'pwd' } }] } });
  assert.equal(transcript.messages.length, 1);
  assert.equal(transcript.messages[0]?.blocks[0], tool);
});

test('out-of-order tool results do not turn a failed tool back into running and interrupted text survives', () => {
  const transcript = new Transcript();
  transcript.apply({ type: 'tool_result', toolUseId: 'tool', messageId: 'result', content: 'failed', isError: true });
  transcript.apply({ type: 'create_message', message: { id: 'owner', role: 'assistant', content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: {} }] } });
  transcript.apply({ type: 'assistant_text_delta', messageId: 'partial', blockIndex: 0, textDelta: 'Unfinished answer' });
  transcript.finish('interrupted');
  const tool = transcript.messages[0]?.blocks[0];
  assert.ok(tool?.kind === 'tool');
  assert.equal(tool.status, 'error');
  assert.equal(tool.output, 'failed');
  assert.equal(transcript.messages[1]?.id, 'partial');
  assert.deepEqual(transcript.messages[1]?.blocks[0], { id: 'partial:0', kind: 'text', text: 'Unfinished answer' });
});

test('hydration replaces prior-session identity tables and retracted messages cannot be resurrected by late deltas', () => {
  const transcript = new Transcript();
  transcript.apply({ type: 'assistant_text_delta', messageId: 'old', blockIndex: 0, textDelta: 'old' });
  transcript.apply({ type: 'assistant_message_retracted', messageId: 'old' });
  transcript.apply({ type: 'assistant_text_delta', messageId: 'old', blockIndex: 0, textDelta: 'late' });
  assert.equal(transcript.messages.length, 0);
  transcript.hydrate([{ id: 'new', role: 'user', content: [{ type: 'text', text: 'new session' }] }]);
  assert.deepEqual(transcript.messages.map(message => message.id), ['new']);
});

test('restored orphan tool results retain their real message ID and image results survive a repeated owner message', () => {
  const transcript = new Transcript();
  transcript.hydrate([{ id: 'orphan-result-id', role: 'user', content: [{ type: 'tool_result', toolUseId: 'orphan-tool', content: 'Original owner was compacted' }] }]);
  assert.equal(transcript.messages[0]?.id, 'orphan-result-id');
  assert.equal(transcript.messages[0]?.blocks[0]?.id, 'orphan-tool');
  const owner = { id: 'owner', role: 'assistant', content: [{ type: 'tool_use', id: 'image-tool', name: 'Read', input: {} }] };
  transcript.apply({ type: 'create_message', message: owner });
  transcript.apply({ type: 'tool_result', toolUseId: 'image-tool', messageId: 'image-result', content: [{ type: 'image', source: { data: 'actual-image-data', mediaType: 'image/png' } }] });
  transcript.apply({ type: 'create_message', message: owner });
  assert.deepEqual(transcript.messages.find(message => message.id === 'owner')?.blocks[1], { id: 'image-tool:result:0', kind: 'image', data: 'actual-image-data', mime: 'image/png' });
});

test('restored reasoning is settled, while real deltas transition through block gaps and terminal settlement', () => {
  const transcript = new Transcript();
  transcript.hydrate([{ id: 'history', role: 'assistant', content: [{ type: 'thinking', thinking: 'Saved reasoning' }] }]);
  assert.equal(transcript.messages[0]?.streaming, undefined, 'history must not start a live thinking clock');
  transcript.apply({ type: 'thinking_text_delta', messageId: 'live', blockIndex: 0, textDelta: 'Visible reasoning' });
  const message = transcript.messages.at(-1)!;
  assert.equal(message.streaming, true);
  transcript.apply({ type: 'thinking_text_complete', messageId: 'live', blockIndex: 0 });
  assert.equal(message.streaming, false, 'a completed thinking block stops pulsing before prose arrives');
  transcript.apply({ type: 'assistant_text_delta', messageId: 'live', blockIndex: 1, textDelta: 'Partial answer' });
  assert.equal(message.streaming, true, 'the next real block resumes streaming on the same message');
  transcript.finish('interrupted');
  assert.equal(message.streaming, undefined);
  assert.deepEqual(message.blocks.map(block => 'text' in block ? block.text : ''), ['Visible reasoning', 'Partial answer']);
});

test('a persisted final message settles live content and late deltas cannot restart its presentation', () => {
  const transcript = new Transcript();
  transcript.apply({ type: 'assistant_text_delta', messageId: 'reply', blockIndex: 0, textDelta: 'Partial' });
  const message = transcript.messages[0]!;
  transcript.apply({ type: 'create_message', message: { id: 'reply', role: 'assistant', content: [{ type: 'text', text: 'Final answer' }] } });
  assert.equal(message.streaming, undefined);
  transcript.apply({ type: 'assistant_text_delta', messageId: 'reply', blockIndex: 0, textDelta: ' late' });
  assert.equal(message.streaming, undefined);
  assert.deepEqual(message.blocks, [{ id: 'reply:0', kind: 'text', text: 'Final answer' }]);
});
