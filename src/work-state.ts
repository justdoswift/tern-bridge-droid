import type { BackendState, MessageBlock } from './contracts.js';
import { record } from './transcript.js';

type ToolBlock = Extract<MessageBlock, { kind: 'tool' }>;
export type WorkSnapshot = { readonly active: false } | {
  readonly active: true;
  readonly startedAt: number;
  readonly stage: 'tool' | 'thinking' | 'response' | 'stopping';
  readonly step?: string;
};
const IDLE: WorkSnapshot = Object.freeze({ active: false });

export function isDroidWorking(state: Pick<BackendState, 'session' | 'phase'>): boolean {
  return state.session !== null && (state.phase === 'running' || state.phase === 'stopping');
}

/** A local observation clock and real tool intent, never reconstructed historical execution time. */
export class DroidWorkTracker {
  private sessionId: string | null | undefined;
  private startedAt: number | undefined;
  private lastTool?: ToolBlock;
  private lastArgs?: string;
  private lastName?: string;
  private step?: string;
  private snapshot: WorkSnapshot = IDLE;

  sync(state: BackendState, now = Date.now()): WorkSnapshot {
    const sessionId = state.session?.id ?? null;
    if (sessionId !== this.sessionId || !['running', 'stopping', 'approval', 'question'].includes(state.phase)) {
      this.sessionId = sessionId;
      this.startedAt = undefined;
      this.lastTool = undefined;
      this.lastArgs = undefined;
      this.lastName = undefined;
      this.step = undefined;
    }
    if (!isDroidWorking(state)) return this.snapshot = IDLE;
    this.startedAt ??= now;
    let tool: ToolBlock | undefined;
    let thinking = false;
    for (let m = state.messages.length - 1; m >= 0; m--) {
      const message = state.messages[m]!;
      if (message.role === 'user') break;
      if (message.role !== 'assistant') continue;
      if (message.streaming === true && message.blocks.at(-1)?.kind === 'thinking') thinking = true;
      for (let b = message.blocks.length - 1; b >= 0; b--) {
        const block = message.blocks[b]!;
        if (block.kind === 'tool' && block.status === 'running' && !block.resultReceived) { tool = block; break; }
      }
      if (tool) break;
    }
    if (tool && (tool !== this.lastTool || tool.args !== this.lastArgs || tool.name !== this.lastName)) {
      this.lastTool = tool;
      this.lastArgs = tool.args;
      this.lastName = tool.name;
      let summary: unknown;
      try { summary = record(JSON.parse(tool.args)).summary; } catch { /* Partial arguments keep the real tool name. */ }
      this.step = typeof summary === 'string' && summary.trim() ? summary : tool.name;
    }
    const stage = state.phase === 'stopping' ? 'stopping' : this.step ? 'tool' : thinking ? 'thinking' : 'response';
    const previous = this.snapshot;
    if (previous.active && previous.startedAt === this.startedAt && previous.stage === stage && previous.step === this.step) return previous;
    return this.snapshot = { active: true, startedAt: this.startedAt, stage, ...(this.step ? { step: this.step } : {}) };
  }
}
