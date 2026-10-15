import type { Locale } from './contracts.js';

const en = {
  identity: 'Droid', untitled: 'Untitled session', newSession: 'New', sessions: 'Sessions', more: 'More',
  model: 'Model', reasoning: 'Reasoning', mode: 'Mode', autonomy: 'Autonomy', default: 'Default',
  send: 'Send', stop: 'Stop', draft: 'Message Droid', draftHint: 'Enter to send · Shift+Enter for a new line',
  empty: 'Start a conversation in this project.', context: 'Context', usage: 'Tokens', input: 'in', output: 'out',
  thinking: 'Thinking', user: 'You', assistant: 'Droid', system: 'Session', args: 'Arguments', toolOutput: 'Output', done: 'Done', interrupted: 'Interrupted', failed: 'Error',
  close: 'Close', cancel: 'Cancel', continue: 'Continue', searchSessions: 'Search sessions', searchModels: 'Search models', noResults: 'No matches', loading: 'Loading sessions…', currentProject: 'This project', allProjects: 'All projects', current: 'Current',
  rename: 'Rename session', compact: 'Compact context', resume: 'Resume by session ID', renameHint: 'Session title', compactHint: 'Optional instructions for compaction', resumeHint: 'Session ID',
  editPlanHint: 'Edit the plan before accepting',
  rewind: 'Rewind conversation', rewindHint: 'Choose the user message to return to. Later messages will be removed.', rewindConfirm: 'Confirm rewind', rewindDetail: 'Remove messages after this point. File restoration is a separate, explicit choice.', restore: 'Restore', remove: 'Delete', unavailable: 'Cannot restore', noFiles: 'No file changes are included.', conversationOnly: 'Conversation only', restoreFiles: 'Rewind and restore files', unavailableHint: 'Some file snapshots are unavailable. File restoration is disabled; you can still rewind the conversation.',
  permission: 'Permission request', plan: 'Plan acceptance', planHint: 'Choosing an offered acceptance option authorizes this plan. It is not only a permission grant.', persistent: 'Persistent grant', once: 'This request only', persistentHint: 'Persistent options apply to future matching requests. Choose one only if you intend to keep granting access.', noPermissions: 'Droid has not offered permission options. Cancel to decline.',
  answer: 'Answer', customAnswer: 'Write your own answer', submitAnswer: 'Submit answer', cancelQuestion: 'Cancel question', questionProgress: 'Question', answered: 'Answered',
  reconnect: 'Reconnect session', reconnectHint: 'Reconnect only; your message will not be sent again.', dismiss: 'Dismiss error', image: 'Conversation image', unknown: 'Not reported', language: 'Language',
};
type Dictionary = { [K in keyof typeof en]: string };
const zh: Dictionary = {
  editPlanHint: '修改计划后接受',
  identity: 'Droid', untitled: '未命名会话', newSession: '新建', sessions: '会话', more: '更多',
  model: '模型', reasoning: '思考强度', mode: '模式', autonomy: '自主权限', default: '默认',
  send: '发送', stop: '停止', draft: '给 Droid 发消息', draftHint: 'Enter 发送 · Shift+Enter 换行',
  empty: '在当前项目开始对话。', context: '上下文', usage: 'Token', input: '输入', output: '输出',
  thinking: '思考过程', user: '你', assistant: 'Droid', system: '会话', args: '参数', toolOutput: '输出', done: '完成', interrupted: '已中断', failed: '错误',
  close: '关闭', cancel: '取消', continue: '继续', searchSessions: '搜索会话', searchModels: '搜索模型', noResults: '没有匹配项', loading: '正在加载会话…', currentProject: '当前项目', allProjects: '所有项目', current: '当前',
  rename: '重命名会话', compact: '压缩上下文', resume: '按会话 ID 恢复', renameHint: '会话名称', compactHint: '可选：压缩时保留哪些信息', resumeHint: '会话 ID',
  rewind: '回退对话', rewindHint: '选择要回到的用户消息，之后的消息将被移除。', rewindConfirm: '确认回退', rewindDetail: '移除此处之后的消息。是否恢复文件，需要另行明确选择。', restore: '恢复', remove: '删除', unavailable: '无法恢复', noFiles: '此次回退不涉及文件变更。', conversationOnly: '仅回退对话', restoreFiles: '回退并恢复文件', unavailableHint: '部分文件快照不可用，无法恢复文件；仍可仅回退对话。',
  permission: '权限请求', plan: '接受计划', planHint: '选择 Droid 提供的接受选项会授权执行此计划，不只是授予权限。', persistent: '持续授权', once: '仅本次请求', persistentHint: '持续授权会用于之后匹配的请求，请确认这是你的意图。', noPermissions: 'Droid 未提供授权选项，可取消以拒绝。',
  answer: '回答', customAnswer: '填写其他回答', submitAnswer: '提交回答', cancelQuestion: '取消提问', questionProgress: '问题', answered: '已回答',
  reconnect: '重新连接会话', reconnectHint: '只重新连接，不会再次发送你的消息。', dismiss: '收起错误', image: '对话图片', unknown: '未提供', language: '语言',
};

export function dictionary(locale: Locale): Dictionary { return locale === 'zh-CN' ? zh : en; }
