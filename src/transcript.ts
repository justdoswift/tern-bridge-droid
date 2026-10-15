import type { ChatMessage, MessageBlock } from './contracts.js';

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((item: unknown) => {
    const block = record(item);
    if (block.type === 'text') return typeof block.text === 'string' ? block.text : '';
    if (block.type === 'document') {
      const source = record(block.source);
      if (source.type === 'text') return typeof source.data === 'string' ? source.data : '';
      return typeof source.parsedData === 'string' ? source.parsedData : `[PDF: ${typeof source.name === 'string' ? source.name : 'attachment'}]`;
    }
    return '';
  }).filter(Boolean).join('\n');
}

type ToolBlock = Extract<MessageBlock, { kind: 'tool' }>;
interface ToolState { block: ToolBlock; owner?: ChatMessage; resultMessageId?: string; images: Extract<MessageBlock, { kind: 'image' }>[] }

/** One reducer for saved messages and live notifications. No guessed message IDs. */
export class Transcript {
  readonly messages: ChatMessage[] = [];
  private readonly byId = new Map<string, ChatMessage>();
  private readonly tools = new Map<string, ToolState>();
  private readonly finalized = new Set<string>();
  private readonly completedBlocks = new Set<string>();
  private readonly partials = new Set<ChatMessage>();

  hydrate(messages: unknown): void {
    this.messages.length = 0;
    this.byId.clear();
    this.tools.clear();
    this.finalized.clear();
    this.completedBlocks.clear();
    this.partials.clear();
    if (Array.isArray(messages)) for (const message of messages) this.upsert(message);
    // Saved incomplete tools must not look as though this process is executing them.
    this.finish('interrupted');
  }

  upsert(value: unknown): void {
    const raw = record(value);
    if (typeof raw.id !== 'string' || !Array.isArray(raw.content)) return;
    const hidden = raw.visibility === 'llm_only' || raw.isUserVisible === false || raw.hiddenFromUserViews === true;
    const role = raw.role === 'user' || raw.role === 'assistant' ? raw.role : 'system';
    const message: ChatMessage = this.byId.get(raw.id) ?? { id: raw.id, role, blocks: [] };
    message.role = role;
    this.partials.delete(message);
    delete message.streaming;
    const blocks: MessageBlock[] = [];
    raw.content.forEach((value: unknown, index: number) => {
      const block = record(value);
      const id = `${raw.id}:${index}`;
      if (block.type === 'tool_result' && typeof block.toolUseId === 'string') {
        this.result(block.toolUseId, block.content, block.isError === true, raw.id as string);
      } else if (!hidden && block.type === 'tool_use' && typeof block.id === 'string') {
        const tool = this.tool(block.id, typeof block.name === 'string' ? block.name : 'Tool');
        tool.block.args = JSON.stringify(block.input ?? {}, null, 2);
        if (tool.owner && tool.owner !== message && tool.owner.id === tool.resultMessageId) this.remove(tool.owner.id);
        tool.owner = message;
        blocks.push(tool.block, ...tool.images);
      } else if (!hidden && block.type === 'text' && typeof block.text === 'string') {
        blocks.push({ id, kind: 'text', text: block.text });
      } else if (!hidden && block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        blocks.push({ id, kind: 'thinking', text: block.thinking });
      } else if (!hidden && block.type === 'image') {
        const source = record(block.source);
        if (typeof source.data === 'string' && typeof source.mediaType === 'string') blocks.push({ id, kind: 'image', data: source.data, mime: source.mediaType });
      } else if (!hidden && block.type === 'document') {
        const source = record(block.source);
        blocks.push({ id, kind: 'text', text: textContent([block]) || `[PDF: ${typeof source.name === 'string' ? source.name : 'attachment'}]` });
      }
      // redacted_thinking, signatures and provider-encrypted content are never exposed.
    });
    if (!hidden && blocks.length) {
      message.blocks = blocks;
      if (!this.byId.has(raw.id)) { this.byId.set(raw.id, message); this.messages.push(message); }
    } else if (hidden) {
      this.remove(raw.id);
    }
    this.finalized.add(raw.id);
  }

  apply(value: unknown): void {
    const event = record(value);
    if (event.type === 'create_message') { this.upsert(event.message); return; }
    if (event.type === 'assistant_message_retracted' && typeof event.messageId === 'string') { this.remove(event.messageId); return; }
    if ((event.type === 'assistant_text_delta' || event.type === 'thinking_text_delta') &&
        typeof event.messageId === 'string' && typeof event.blockIndex === 'number' && typeof event.textDelta === 'string') {
      const id = `${event.messageId}:${event.blockIndex}`;
      if (this.finalized.has(event.messageId) || this.completedBlocks.has(id)) return;
      let message = this.byId.get(event.messageId);
      if (!message) {
        message = { id: event.messageId, role: 'assistant', blocks: [] };
        this.byId.set(message.id, message);
        this.messages.push(message);
      }
      message.streaming = true;
      this.partials.add(message);
      let block = message.blocks.find(item => item.id === id);
      if (!block) {
        block = { id, kind: event.type === 'thinking_text_delta' ? 'thinking' : 'text', text: '' };
        message.blocks.push(block);
        message.blocks.sort((a, b) => Number(a.id.slice(a.id.lastIndexOf(':') + 1)) - Number(b.id.slice(b.id.lastIndexOf(':') + 1)));
      }
      if (block.kind === 'text' || block.kind === 'thinking') block.text += event.textDelta;
    } else if ((event.type === 'assistant_text_complete' || event.type === 'thinking_text_complete') && typeof event.messageId === 'string') {
      this.completedBlocks.add(`${event.messageId}:${event.blockIndex}`);
      const message = this.byId.get(event.messageId);
      if (message && this.partials.has(message) && message.blocks.every(block =>
        block.kind !== 'text' && block.kind !== 'thinking' || this.completedBlocks.has(block.id))) message.streaming = false;
    } else if (event.type === 'tool_call') {
      const use = record(event.toolUse);
      if (typeof use.id === 'string') {
        const tool = this.tool(use.id, typeof use.name === 'string' ? use.name : 'Tool');
        tool.block.args = JSON.stringify(use.input ?? {}, null, 2);
      }
    } else if (event.type === 'tool_result' && typeof event.toolUseId === 'string') {
      this.result(event.toolUseId, event.content, event.isError === true, typeof event.messageId === 'string' ? event.messageId : undefined);
    } else if (event.type === 'tool_progress_update' && typeof event.toolUseId === 'string') {
      const tool = this.tool(event.toolUseId, typeof event.toolName === 'string' ? event.toolName : 'Tool').block;
      const update = record(event.update);
      if (typeof update.fullOutput === 'string') tool.output = update.fullOutput;
      else if (typeof update.text === 'string') tool.output += update.text;
      else if (typeof update.details === 'string') tool.output = update.details;
      else if (typeof update.valueSnippet === 'string') tool.output = update.valueSnippet;
      else if (typeof update.status === 'string') tool.output = update.status;
      if (typeof update.error === 'string') { tool.output = update.error; tool.status = 'error'; }
      if (update.type === 'tool_result') tool.status = 'done';
    } else if (event.type === 'tool_execution_phase_changed' && typeof event.toolUseId === 'string') {
      const tool = this.tool(event.toolUseId, typeof event.toolName === 'string' ? event.toolName : 'Tool').block;
      if (event.phase === 'executing' || event.phase === 'streaming_input' || event.phase === 'queued') tool.status = 'running';
      else if (event.phase === 'settled_without_execution' && tool.status === 'running') tool.status = 'interrupted';
    }
  }

  finish(status: 'done' | 'error' | 'interrupted'): void {
    for (const message of this.partials) delete message.streaming;
    this.partials.clear();
    for (const tool of this.tools.values()) {
      if (tool.block.status === 'running') tool.block.status = status;
      if (!tool.owner && tool.resultMessageId) {
        let message = this.byId.get(tool.resultMessageId);
        if (!message) {
          message = { id: tool.resultMessageId, role: 'system', blocks: [] };
          this.byId.set(message.id, message); this.messages.push(message);
        }
        message.blocks.push(tool.block, ...tool.images); tool.owner = message;
      }
    }
  }

  private tool(id: string, name: string): ToolState {
    let tool = this.tools.get(id);
    if (!tool) {
      tool = { block: { id, kind: 'tool', name, args: '', output: '', status: 'running' }, images: [] };
      this.tools.set(id, tool);
    } else if (name !== 'Tool') tool.block.name = name;
    return tool;
  }

  private result(id: string, content: unknown, isError: boolean, messageId?: string): void {
    const tool = this.tool(id, 'Tool');
    if (content !== undefined) tool.block.output = textContent(content);
    tool.block.status = isError ? 'error' : 'done';
    if (messageId) tool.resultMessageId = messageId;
    if (Array.isArray(content)) {
      tool.images = content.flatMap((value: unknown, index: number) => {
        const block = record(value); const source = record(block.source);
        return block.type === 'image' && typeof source.data === 'string' && typeof source.mediaType === 'string'
          ? [{ id: `${id}:result:${index}`, kind: 'image' as const, data: source.data, mime: source.mediaType }] : [];
      });
      if (tool.owner) {
        tool.owner.blocks = tool.owner.blocks.filter(block => !block.id.startsWith(`${id}:result:`));
        tool.owner.blocks.push(...tool.images);
      }
    }
  }

  private remove(id: string): void {
    const index = this.messages.findIndex(message => message.id === id);
    const message = this.byId.get(id);
    if (message) this.partials.delete(message);
    if (index >= 0) this.messages.splice(index, 1);
    this.byId.delete(id);
    this.finalized.add(id);
  }
}
