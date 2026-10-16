import { ListSkillsResultSchema } from '@factory/droid-sdk';
import type { Locale } from './contracts.js';
import { record } from './transcript.js';

export interface DroidCommand { name: string; description: string; kind: 'command' | 'skill'; argumentHint?: string }
export interface CommandCatalog {
  status: 'loading' | 'ready' | 'error';
  entries: readonly DroidCommand[];
  error: string | null;
}

const descriptions = {
  sessions: ['选择历史会话', 'Saved conversations'], new: ['新建会话', 'New conversation'], resume: ['恢复保存的会话', 'Resume a saved conversation'],
  model: ['选择模型', 'Select model'], reasoning: ['选择思考强度', 'Reasoning effort'], mode: ['Auto / Spec 模式', 'Auto / Spec mode'],
  autonomy: ['审批策略', 'Approval policy'], rename: ['重命名会话', 'Rename conversation'], fork: ['分叉会话', 'Fork conversation'],
  compact: ['压缩上下文（可能消耗模型额度）', 'Compact context (may use model quota)'], rewind: ['查看回退选项', 'Inspect rewind'],
  context: ['上下文用量明细', 'Context usage breakdown'], retry: ['重新连接，不重发消息', 'Reconnect without replay'],
  commands: ['重新发现命令和技能', 'Refresh commands and skills'], language: ['中文 / English', '中文 / English'],
  help: ['可用命令和会话操作', 'Available commands and conversation actions'], quit: ['关闭客户端', 'Close client'],
} as const;
export type BridgeCommand = keyof typeof descriptions;
export interface CommandEntry { name: string; description: string }
export type CommandRoute = { kind: 'local'; name: BridgeCommand; argument?: string } | { kind: 'remote' | 'message' | 'unknown' | 'unavailable' };

/** The SDK lists effective skills, not every file on disk. Never retain skill bodies in menu state. */
export function discoveredCommands(commands: unknown, skills: unknown): DroidCommand[] {
  const result = new Map<string, DroidCommand>();
  // listCommands validates its response inside DroidClient; its result schema
  // is not publicly exported by SDK 0.9.1. Keep this metadata boundary explicit.
  const rows = record(commands).commands;
  if (!Array.isArray(rows)) throw new Error('Invalid Droid command catalog.');
  for (const value of rows) {
    const command = record(value);
    if (typeof command.name !== 'string' || typeof command.description !== 'string' ||
      (command.argumentHint !== undefined && typeof command.argumentHint !== 'string')) throw new Error('Invalid Droid command metadata.');
    if (!command.name || /[\s/]/.test(command.name)) continue;
    result.set(command.name.toLowerCase(), { name: command.name, description: command.description, kind: 'command',
      ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}) });
  }
  for (const skill of ListSkillsResultSchema.parse(skills).skills) {
    // The 0.9.1 protocol omits validationResult. These are the native skill
    // validator's observable hard failures; long descriptions/prompts only warn.
    if (skill.enabled === false || skill.userInvocable === false || skill.disabledBy ||
        !/^[a-z0-9-]+$/.test(skill.name) || !/[a-z0-9]/.test(skill.name) || skill.content === '') continue;
    const key = skill.name.toLowerCase();
    if (!result.has(key)) result.set(key, { name: skill.name, description: skill.description ?? '', kind: 'skill' });
  }
  return [...result.values()];
}

/** Remote commands own convenience aliases; bridge:* is the explicitly reserved local namespace. */
export function commandEntries(locale: Locale, catalog: CommandCatalog): CommandEntry[] {
  const zh = locale === 'zh-CN';
  const remote = catalog.status === 'ready' ? catalog.entries : [];
  const names = new Set(remote.map(item => item.name.toLowerCase()));
  return [
    ...remote.filter(item => !item.name.toLowerCase().startsWith('bridge:')).map(item => ({ name: item.name,
      description: `${item.kind === 'skill' ? zh ? '技能' : 'Skill' : zh ? 'Droid 命令' : 'Droid command'} · ${item.description || item.name}${item.argumentHint ? ` · ${item.argumentHint}` : ''}` })),
    ...(Object.keys(descriptions) as BridgeCommand[]).flatMap(name => {
      const description = `Bridge · ${descriptions[name][zh ? 0 : 1]}`;
      return [{ name: `bridge:${name}`, description }, ...(catalog.status === 'ready' && !names.has(name) ? [{ name, description }] : [])];
    }),
  ];
}

/** Slash intent is explicit, including with attachments; it never silently falls through to prose. */
export function routeCommand(message: string, catalog: CommandCatalog): CommandRoute {
  const trimmed = message.trimStart();
  if (!trimmed.startsWith('/')) return { kind: 'message' };
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return { kind: 'unknown' };
  const name = match[1]!.toLowerCase();
  if (name.startsWith('bridge:')) {
    const local = name.slice(7);
    return Object.hasOwn(descriptions, local) ? { kind: 'local', name: local as BridgeCommand, argument: match[2] } : { kind: 'unknown' };
  }
  if (catalog.status !== 'ready') return { kind: 'unavailable' };
  if (catalog.entries.some(command => command.name.toLowerCase() === name)) return { kind: 'remote' };
  if (Object.hasOwn(descriptions, name)) return { kind: 'local', name: name as BridgeCommand, argument: match[2] };
  return { kind: 'unknown' };
}
