import type { TodoItem } from '@oh-my-pi/pi-tui/tools/todo';
import type { ChatMessage, MessageBlock } from './contracts.js';
import { record } from './transcript.js';

type ToolBlock = Extract<MessageBlock, { kind: 'tool' }>;

/** Droid TodoWrite's numbered, status-tagged string; never infer tasks from prose. */
export function parseDroidTodos(args: string): TodoItem[] | undefined {
  let source: unknown;
  try { source = record(JSON.parse(args)).todos; } catch { return undefined; }
  if (typeof source !== 'string') return undefined;
  const tasks: TodoItem[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^\s*(?:\d+\.\s*)?\[(pending|in_progress|completed)\]\s+(.+?)\s*$/.exec(line);
    if (match) {
      tasks.push({ content: match[2]!, status: match[1] as TodoItem['status'] });
    } else if (/^\s+\S/.test(line) && !/^\s*(?:\d+\.\s*)?\[/.test(line) && tasks.length) {
      tasks[tasks.length - 1]!.content += `\n${line.trim()}`;
    } else return undefined;
  }
  return tasks;
}

/** Last confirmed successful write in transcript order; pending/failed writes change nothing. */
export function latestDroidTodo(messages: readonly ChatMessage[]): ToolBlock | undefined {
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m]!;
    if (message.role !== 'assistant') continue;
    for (let b = message.blocks.length - 1; b >= 0; b--) {
      const block = message.blocks[b]!;
      if (block.kind === 'tool' && block.name === 'TodoWrite' && block.status === 'done' && block.resultReceived) return block;
    }
  }
  return undefined;
}
