import assert from 'node:assert/strict';
import test from 'node:test';
import { latestDroidTodo, parseDroidTodos } from '../src/droid-todos.js';
import { Transcript } from '../src/transcript.js';

function call(id: string, todos: string) {
  return { id: `message-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'TodoWrite', input: { todos } }] };
}
function settle(transcript: Transcript, id: string, error = false) {
  transcript.apply({ type: 'tool_result', toolUseId: id, content: error ? 'Rejected' : 'TODO List Updated', isError: error });
}
function tasks(transcript: Transcript) {
  const source = latestDroidTodo(transcript.messages);
  return source ? parseDroidTodos(source.args) : undefined;
}

test('Droid status-tagged strings preserve actual task order, states and multiline content', () => {
  assert.deepEqual(parseDroidTodos(JSON.stringify({ todos: '1. [completed] 查看代码\r\n2. [in_progress] Implement UI\r\n   Keep keyboard focus\r\n\r\n3. [pending] Check `const x = 1`' })), [
    { content: '查看代码', status: 'completed' },
    { content: 'Implement UI\nKeep keyboard focus', status: 'in_progress' },
    { content: 'Check `const x = 1`', status: 'pending' },
  ]);
  for (const todos of ['ordinary prose', '1. [completed] Good\n2. [unknown] Unknown', '1. [pending] Good\nUnmarked task', '1. [pending]']) {
    assert.equal(parseDroidTodos(JSON.stringify({ todos })), undefined);
  }
  assert.equal(parseDroidTodos('{"todos":'), undefined);
  assert.equal(parseDroidTodos(JSON.stringify({ todos: [{ content: 'not the Droid string contract' }] })), undefined);
});

test('unexecuted, failed and interrupted TodoWrite calls cannot replace a confirmed task list', () => {
  const transcript = new Transcript();
  transcript.upsert(call('saved', '1. [in_progress] Actual work'));
  settle(transcript, 'saved');
  transcript.upsert(call('pending', '1. [completed] Must not show'));
  transcript.finish('done');
  assert.deepEqual(tasks(transcript), [{ content: 'Actual work', status: 'in_progress' }]);
  settle(transcript, 'pending', true);
  assert.deepEqual(tasks(transcript), [{ content: 'Actual work', status: 'in_progress' }]);
  transcript.upsert(call('stopped', '1. [completed] Still not executed'));
  transcript.finish('interrupted');
  assert.deepEqual(tasks(transcript), [{ content: 'Actual work', status: 'in_progress' }]);
});

test('only an authoritative result publishes progress; out-of-order owners retain that result', () => {
  const transcript = new Transcript();
  settle(transcript, 'late-owner');
  assert.equal(tasks(transcript), undefined);
  transcript.upsert(call('late-owner', '1. [pending] Restored task'));
  assert.deepEqual(tasks(transcript), [{ content: 'Restored task', status: 'pending' }]);
  transcript.upsert(call('live', '1. [completed] Updated task'));
  transcript.apply({ type: 'tool_progress_update', toolUseId: 'live', update: { type: 'tool_result', fullOutput: 'preview' } });
  assert.deepEqual(tasks(transcript), [{ content: 'Restored task', status: 'pending' }]);
  settle(transcript, 'live');
  assert.deepEqual(tasks(transcript), [{ content: 'Updated task', status: 'completed' }]);
});

test('history restores the last successful list and session replacement/retraction cannot leak another list', () => {
  const transcript = new Transcript();
  transcript.hydrate([
    call('history', '1. [completed] Read\n2. [pending] Verify'),
    { id: 'result', role: 'user', content: [{ type: 'tool_result', toolUseId: 'history', content: 'TODO List Updated' }] },
    { id: 'user-text', role: 'user', content: [{ type: 'text', text: 'TodoWrite: 1. [completed] Not a tool call' }] },
  ]);
  assert.deepEqual(tasks(transcript), [{ content: 'Read', status: 'completed' }, { content: 'Verify', status: 'pending' }]);
  transcript.apply({ type: 'assistant_message_retracted', messageId: 'message-history' });
  assert.equal(tasks(transcript), undefined);
  transcript.hydrate([call('other-session', '1. [pending] Not executed')]);
  assert.equal(tasks(transcript), undefined);
});

test('a confirmed empty or unrecognized replacement never resurrects older tasks', () => {
  const transcript = new Transcript();
  transcript.upsert(call('old', '1. [pending] Old task'));
  settle(transcript, 'old');
  transcript.upsert(call('clear', ''));
  settle(transcript, 'clear');
  assert.deepEqual(tasks(transcript), []);
  transcript.upsert(call('unknown', 'new format not supported'));
  settle(transcript, 'unknown');
  assert.equal(tasks(transcript), undefined);
  assert.equal(latestDroidTodo(transcript.messages)?.id, 'unknown');
});
