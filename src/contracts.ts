import type { ContextBreakdownResult } from '@factory/droid-sdk';

export type ContextDetails = Pick<ContextBreakdownResult,
  'modelId' | 'modelDisplayName' | 'contextBudget' | 'usedTokens' | 'freeTokens' | 'categories'>;

export type Locale = 'zh-CN' | 'en-US';
export type Phase = 'disconnected' | 'connecting' | 'idle' | 'running' | 'approval' | 'question' | 'stopping' | 'error';
export type MessageBlock =
  | { id: string; kind: 'text' | 'thinking' | 'code' | 'diff'; text: string; path?: string }
  | { id: string; kind: 'tool'; name: string; args: string; output: string; status: 'running' | 'done' | 'error' | 'interrupted'; resultReceived?: true; diff?: string }
  | { id: string; kind: 'image'; data: string; mime: string };
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  blocks: MessageBlock[];
  /** Display lifecycle only: true during deltas, false between blocks, absent once settled/restored. */
  streaming?: boolean;
}
export interface InputImage {
  data: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}
export interface ModelChoice {
  id: string;
  label: string;
  reasoningEfforts: string[];
  defaultReasoningEffort?: string;
  noImageSupport?: boolean;
}
export interface SettingsView {
  modelId: string;
  reasoningEffort: string;
  autonomyLevel: string;
  interactionMode: string;
  availableAutonomyLevels?: string[];
}
export interface SessionInfo {
  id: string;
  title: string;
  cwd: string;
  settings: SettingsView;
}
export interface SessionSummary {
  id: string;
  title: string;
  cwd?: string;
  modifiedTime?: string | number;
}
export interface ApprovalOption { value: string; label: string; persistent: boolean; disabledReason?: string }
export interface PendingApproval {
  id: string;
  title: string;
  detail: string;
  plan?: string;
  options: ApprovalOption[];
}
export interface QuestionItem { index: number; question: string; options: string[]; topic?: string; multiSelect?: boolean }
export interface PendingQuestion { id: string; questions: QuestionItem[] }
export interface QuestionAnswer { index: number; question: string; answer: string }
export interface BackendState {
  phase: Phase;
  needsInterrupt: boolean;
  session: SessionInfo | null;
  messages: ChatMessage[];
  models: ModelChoice[];
  approval: PendingApproval | null;
  question: PendingQuestion | null;
  error: string | null;
  notice: string | null;
  context: { used: number; limit: number } | null;
  usage: { input: number; output: number } | null;
}
export interface SettingsPatch {
  modelId?: string;
  reasoningEffort?: string;
  autonomyLevel?: string;
  interactionMode?: string;
}
export interface RewindPlan {
  messageId: string;
  filesToRestore: { filePath: string; contentHash: string; size: number }[];
  filesToDelete: { filePath: string }[];
  unavailable: string[];
}
export interface BridgeBackend {
  readonly state: BackendState;
  open(sessionId?: string): Promise<void>;
  sessions(all: boolean): Promise<SessionSummary[]>;
  contextDetails(): Promise<ContextDetails>;
  send(text: string, onAccepted: () => void, images?: readonly InputImage[]): Promise<void>;
  interrupt(): Promise<void>;
  resolveApproval(requestId: string, value: string, editedSpecContent?: string): void;
  resolveQuestion(requestId: string, answers: QuestionAnswer[] | null): void;
  updateSettings(patch: SettingsPatch): Promise<void>;
  rename(title: string): Promise<void>;
  fork(): Promise<void>;
  compact(instructions?: string): Promise<void>;
  prepareRewind(messageId: string): Promise<RewindPlan>;
  rewind(plan: RewindPlan, restoreFiles: boolean): Promise<void>;
  close(): Promise<void>;
}
export interface BackendOptions {
  cwd: string;
  dataDir: string;
  execPath?: string;
  onChange: () => void;
}
