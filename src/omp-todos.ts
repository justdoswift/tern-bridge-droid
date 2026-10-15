import { Text } from '@oh-my-pi/pi-tui/components/text';
import { EMPTY_NODE, node, stableKey } from '@oh-my-pi/pi-tui/native/describe';
import type { NativeNode } from '@oh-my-pi/pi-tui/native/node';
import { todoChecklistPhases } from '@oh-my-pi/pi-tui/tools/todo';
import type { BackendState, Locale } from './contracts.js';
import { latestDroidTodo, parseDroidTodos } from './droid-todos.js';
import { dictionary } from './i18n.js';

/** Display-only binding to Tern's native dock pill and checklist popover. */
export class DroidTodoHud extends Text {
  private native: NativeNode = EMPTY_NODE;
  private source: string | undefined;
  private locale: Locale | undefined;
  private sessionId: string | null | undefined;

  constructor() { super('', 0, 0); }

  sync(state: BackendState, locale: Locale): void {
    const sessionId = state.session?.id ?? null;
    const source = sessionId ? latestDroidTodo(state.messages)?.args : undefined;
    if (this.source === source && this.locale === locale && this.sessionId === sessionId) return;
    this.source = source;
    this.locale = locale;
    this.sessionId = sessionId;
    const tasks = source === undefined ? undefined : parseDroidTodos(source);
    this.native = tasks?.length ? node('checklist', {
      mode: 'hud', role: 'omp.todo.hud',
      phases: todoChecklistPhases([{ name: dictionary(locale).tasks, tasks }]),
    }, undefined, stableKey(sessionId!)) : EMPTY_NODE;
    this.setText(tasks?.map(task => `${task.status === 'completed' ? '[x]' : task.status === 'in_progress' ? '[>]' : '[ ]'} ${task.content}`).join('\n') ?? '');
  }

  override describe(): NativeNode { return this.native; }
}
