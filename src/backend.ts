import { randomUUID } from 'node:crypto';
import {
  AutonomyLevel, DroidClient, ProcessTransport, ReasoningEffort, DroidInteractionMode,
  ToolConfirmationOutcome, ContextBreakdownResultSchema, listSessions, resolveExecCoreDeps,
} from '@factory/droid-sdk/node';
import type { BridgeBackend, BackendOptions, BackendState, ContextDetails, ModelChoice, PendingApproval, PendingQuestion, QuestionAnswer, RewindPlan, SessionSummary, SettingsPatch, SettingsView } from './contracts.js';
import { SessionLock, SessionLockError } from './session-lock.js';
import { Transcript, record } from './transcript.js';

export type BridgeClient = Pick<DroidClient,
  'initializeSession' | 'loadSession' | 'addUserMessage' | 'interruptSession' | 'updateSessionSettings' |
  'listModels' | 'getContextStats' | 'getContextBreakdown' | 'getRewindInfo' | 'executeRewind' | 'compactSession' | 'forkSession' |
  'renameSession' | 'onNotification' | 'onError' | 'setPermissionHandler' | 'clearPermissionHandler' |
  'setAskUserHandler' | 'clearAskUserHandler' | 'close' | 'isConnected'>;
export interface BridgeRuntime {
  create(options: BackendOptions): { client: BridgeClient; connect: () => Promise<void> };
  listSessions: typeof listSessions;
}

const runtime: BridgeRuntime = {
  create(options) {
    const deps = resolveExecCoreDeps(undefined);
    // The SDK's transport logger reads the HOST env, not ProcessTransport.env.
    // Disable it through the public dependency seam without touching user env.
    const transport = new ProcessTransport({
      droidExecPath: options.execPath, cwd: options.cwd,
      env: { FACTORY_DROID_SDK_TRANSPORT_LOG: '0' },
    }, { ...deps, environmentResolver: { ...deps.environmentResolver, resolveTransportLogEnvValue: () => undefined } });
    const client = new DroidClient({ transport });
    return { client, connect: () => transport.connect() };
  },
  listSessions,
};

class BridgeFailure extends Error {}

function failure(error: unknown, action: string): BridgeFailure {
  if (error instanceof BridgeFailure || error instanceof SessionLockError) return new BridgeFailure(error.message);
  const name = error instanceof Error ? error.name : '';
  const metadata = record(record(error).metadata);
  const code = record(error).code ?? metadata.code;
  if (code === 'ENOENT' || metadata.message === 'executable not found') return new BridgeFailure(`${action}: Droid could not start. Check the executable path and working directory.`);
  if (code === -32004 || name === 'SessionNotFoundError') return new BridgeFailure(`${action}: the saved session was not found. Choose another session.`);
  if (name === 'TimeoutError') return new BridgeFailure(`${action}: Droid did not confirm the request in time. Nothing was resubmitted; inspect the session before sending again.`);
  if (name === 'ConnectionError' || name === 'ProcessExitError') return new BridgeFailure(`${action}: the Droid connection ended. No prompt was replayed. Reopen the saved session after checking Droid CLI login and executable access.`);
  if (name === 'ProtocolError') return new BridgeFailure(`${action}: Droid rejected the request${typeof code === 'number' ? ` (code ${code})` : ''}. Check the selected session, model and CLI login.`);
  return new BridgeFailure(`${action}: Droid could not complete the operation. Check CLI login, executable access and session availability. No request was automatically retried.`);
}

function result(response: unknown): Record<string, unknown> {
  const envelope = record(response);
  if (envelope.error) {
    const code = record(envelope.error).code;
    throw new BridgeFailure(`Droid rejected the request${typeof code === 'number' ? ` (code ${code})` : ''}. Check session availability and the current settings.`);
  }
  if (!envelope.result || typeof envelope.result !== 'object') throw new BridgeFailure('Droid returned no confirmed result. Check that the CLI supports the installed SDK.');
  return record(envelope.result);
}

export function normalizeModels(value: unknown, selected?: SettingsView): ModelChoice[] {
  const models = new Map<string, ModelChoice>();
  if (Array.isArray(value)) for (const item of value) {
    const model = record(item);
    if (typeof model.id !== 'string' || model.disabled === true) continue;
    models.set(model.id, {
      id: model.id,
      label: typeof model.displayName === 'string' ? model.displayName : model.id,
      reasoningEfforts: Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts.filter((effort): effort is string => typeof effort === 'string') : [],
      ...(typeof model.defaultReasoningEffort === 'string' ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
    });
  }
  if (selected?.modelId && !models.has(selected.modelId)) models.set(selected.modelId, { id: selected.modelId, label: selected.modelId, reasoningEfforts: selected.reasoningEffort ? [selected.reasoningEffort] : [] });
  return [...models.values()];
}

function settings(value: unknown, previous?: SettingsView): SettingsView {
  const source = record(value);
  return {
    modelId: typeof source.modelId === 'string' ? source.modelId : previous?.modelId ?? '',
    reasoningEffort: typeof source.reasoningEffort === 'string' ? source.reasoningEffort : previous?.reasoningEffort ?? '',
    autonomyLevel: typeof source.autonomyLevel === 'string' ? source.autonomyLevel : previous?.autonomyLevel ?? '',
    interactionMode: typeof source.interactionMode === 'string' ? source.interactionMode : previous?.interactionMode ?? '',
    ...(Array.isArray(source.availableAutonomyLevels)
      ? { availableAutonomyLevels: source.availableAutonomyLevels.filter((level): level is string => typeof level === 'string' && Object.values(AutonomyLevel).includes(level as AutonomyLevel)) }
      : previous?.availableAutonomyLevels !== undefined ? { availableAutonomyLevels: previous.availableAutonomyLevels } : {}),
  };
}

const PENDING_SNAPSHOT_NOTICE = 'Droid reported a pending prompt without reissuing its live request. This session is read-only until a live request arrives or Stop confirms idle. Otherwise answer it in its original owner and reopen the session.';
type PermissionResult = { selectedOption: ToolConfirmationOutcome; editedSpecContent?: string };
type QuestionResult = { cancelled?: boolean; answers: QuestionAnswer[] };
type Prompt =
  | { kind: 'approval'; id: string; view: PendingApproval; promise: Promise<PermissionResult>; settle: (value: PermissionResult) => void }
  | { kind: 'question'; id: string; view: PendingQuestion; promise: Promise<QuestionResult>; settle: (value: QuestionResult) => void };
interface Scope {
  client: BridgeClient;
  id: string | null;
  targetId: string | null;
  loading: boolean;
  events: unknown[];
  cleanups: (() => void)[];
  locks: Map<string, SessionLock>;
  prompts: Prompt[];
  disposed: Promise<void> | null;
  connecting: Promise<void> | null;
  revision: number;
  stopping: boolean;
  remoteBusy: boolean;
  permissionResults: Map<string, PermissionResult>;
  questionResults: Map<string, QuestionResult>;
  terminalIds: Set<string>;
  unansweredSnapshots: Set<string>;
}
interface Turn {
  scope: Scope;
  requestId: string;
  messageId: string;
  accepted: boolean;
  accept: () => void;
  settle: (error?: Error) => void;
  completed: boolean;
}

export class DroidBridge implements BridgeBackend {
  readonly state: BackendState = {
    phase: 'disconnected', session: null, messages: [], models: [], approval: null, question: null,
    error: null, notice: null, context: null, usage: null, needsInterrupt: false,
  };
  private scope: Scope | null = null;
  private transcript = new Transcript();
  private active: Turn | null = null;
  private operation: symbol | null = null;
  private prepared: { scope: Scope; plan: RewindPlan } | null = null;

  constructor(private readonly options: BackendOptions, private readonly sdk: BridgeRuntime = runtime) {}

  async open(sessionId?: string): Promise<void> {
    if (this.operation) throw new BridgeFailure('A session operation is already in progress. Wait for it to finish.');
    const token = Symbol();
    this.operation = token;
    try {
      const previous = this.scope;
      this.scope = null;
      this.cancelTurn(previous, 'Session changed. The previous prompt was not replayed.');
      if (previous) await this.dispose(previous);
      if (this.operation !== token) throw new BridgeFailure('Session opening was cancelled.');
      this.state.phase = 'connecting';
      this.state.error = null;
      this.state.notice = null;
      this.changed();
      await this.connect(sessionId);
    } catch (error) {
      const problem = failure(error, 'Open session');
      if (this.operation === token) { this.state.phase = 'error'; this.state.error = problem.message; this.changed(); }
      throw problem;
    } finally { if (this.operation === token) this.operation = null; }
  }

  async sessions(all: boolean): Promise<SessionSummary[]> {
    try {
      const entries = await this.sdk.listSessions({ cwd: this.options.cwd, fetchOutsideCWD: all });
      return entries.map(entry => ({ id: entry.id, title: entry.title, cwd: entry.cwd, modifiedTime: entry.modifiedTime.toISOString() }));
    } catch (error) { throw this.report(error, 'List sessions'); }
  }

  async contextDetails(): Promise<ContextDetails> {
    const scope = this.ready();
    const revision = scope.revision;
    try {
      const response = result(await scope.client.getContextBreakdown());
      if (this.scope !== scope || scope.revision !== revision) throw new BridgeFailure('The session changed while reading context usage.');
      const parsed = ContextBreakdownResultSchema.safeParse(response);
      if (!parsed.success) throw new BridgeFailure('Droid did not return a supported context breakdown. Check the CLI version.');
      return parsed.data;
    } catch (error) {
      // A read-only report failure must not fail or reconnect the conversation.
      throw failure(error, 'Read context usage');
    }
  }

  async send(text: string, onAccepted: () => void): Promise<void> {
    const scope = this.ready();
    if (!text.trim()) throw new BridgeFailure('Enter a message before sending.');
    if (this.active || this.operation || this.state.phase !== 'idle') throw new BridgeFailure('Droid already has active work. Stop it or wait before sending another message.');
    if (scope.unansweredSnapshots.size) throw new BridgeFailure(PENDING_SNAPSHOT_NOTICE);
    const { promise: done, resolve: resolveDone, reject: rejectDone } = Promise.withResolvers<void>();
    // The transport may fail while addUserMessage is still awaiting its response.
    // Observe the terminal promise immediately; send still propagates its failure.
    void done.catch(() => undefined);
    const turn: Turn = {
      scope, requestId: randomUUID(), messageId: randomUUID(), accepted: false, accept: onAccepted,
      completed: false,
      settle(error) { if (turn.completed) return; turn.completed = true; if (error) rejectDone(error); else resolveDone(); },
    };
    this.active = turn;
    this.prepared = null;
    scope.remoteBusy = true;
    this.state.error = null; this.state.notice = null; this.state.phase = 'running'; this.changed();
    try {
      await Promise.race([
        scope.client.addUserMessage({ text, messageId: turn.messageId }, turn.requestId).then(result),
        done,
      ]);
      await done;
    } catch (error) {
      const problem = failure(error, 'Send message');
      turn.settle(problem);
      if (this.scope === scope && this.active === turn) {
        this.transcript.finish('error'); this.state.phase = 'error'; this.state.error = problem.message;
        this.cancelPrompts(scope); this.changed();
      }
      throw problem;
    } finally { if (this.active === turn) this.active = null; }
  }

  async interrupt(): Promise<void> {
    const scope = this.ready();
    this.cancelPrompts(scope);
    if (!this.active && this.state.phase === 'idle') { this.changed(); return; }
    scope.stopping = true;
    this.state.phase = 'stopping'; this.changed();
    try { result(await scope.client.interruptSession()); }
    catch (error) { throw this.report(error, 'Stop Droid'); }
    // Keep the active-send guard until Droid reports idle/completion, not merely
    // until the interrupt RPC has been acknowledged.
  }

  resolveApproval(requestId: string, value: string, editedSpecContent?: string): void {
    const scope = this.scope;
    const prompt = scope?.prompts[0];
    if (!scope || !prompt || prompt.kind !== 'approval' || prompt.id !== requestId) return;
    if (!prompt.view.options.some(option => option.value === value)) { this.state.error = 'Choose one of the permission outcomes actually offered by Droid.'; this.changed(); return; }
    if (value === ToolConfirmationOutcome.ProceedEdit && !editedSpecContent?.trim()) { this.state.error = 'An edited plan is required for this outcome. Edit the plan or choose another offered outcome.'; this.changed(); return; }
    scope.prompts.shift();
    const disabledReason = prompt.view.options.find(option => option.value === value)?.disabledReason;
    if (disabledReason) { scope.prompts.unshift(prompt); this.state.error = disabledReason; this.changed(); return; }
    prompt.settle({ selectedOption: value as ToolConfirmationOutcome, ...(value === ToolConfirmationOutcome.ProceedEdit ? { editedSpecContent } : {}) });
    this.state.error = null;
    this.showPrompt(scope);
  }

  resolveQuestion(requestId: string, answers: QuestionAnswer[] | null): void {
    const scope = this.scope;
    const prompt = scope?.prompts[0];
    if (!scope || !prompt || prompt.kind !== 'question' || prompt.id !== requestId) return;
    if (answers && (answers.length !== prompt.view.questions.length || new Set(answers.map(item => item.index)).size !== answers.length ||
        prompt.view.questions.some(question => !answers.some(answer => answer.index === question.index && answer.question === question.question && answer.answer.trim())))) {
      this.state.error = 'Answer every current question, or cancel the questionnaire.'; this.changed(); return;
    }
    scope.prompts.shift();
    prompt.settle(answers ? { answers } : { cancelled: true, answers: [] });
    this.state.error = null;
    this.showPrompt(scope);
  }

  async updateSettings(patch: SettingsPatch): Promise<void> {
    if (patch.autonomyLevel !== undefined) {
      const allowed = this.state.session?.settings.availableAutonomyLevels;
      if (!Object.values(AutonomyLevel).includes(patch.autonomyLevel as AutonomyLevel) || (allowed && !allowed.includes(patch.autonomyLevel))) {
        throw new BridgeFailure('This autonomy level is not available under the current Droid policy.');
      }
    }
    await this.mutate('Update settings', async scope => {
      if (patch.reasoningEffort !== undefined && !Object.values(ReasoningEffort).includes(patch.reasoningEffort as ReasoningEffort)) throw new BridgeFailure('The requested reasoning effort is not supported by the SDK.');
      if (patch.interactionMode !== undefined && !Object.values(DroidInteractionMode).includes(patch.interactionMode as DroidInteractionMode)) throw new BridgeFailure('Choose Auto or Spec mode.');
      result(await scope.client.updateSessionSettings({ ...patch, reasoningEffort: patch.reasoningEffort as ReasoningEffort | undefined, autonomyLevel: patch.autonomyLevel as AutonomyLevel | undefined, interactionMode: patch.interactionMode as DroidInteractionMode | undefined }, randomUUID()));
      // The low-level update response is {}. Load returns authoritative settings
      // even if a settings_updated notification was absent or raced the RPC.
      await this.reload(scope);
      const actual = this.state.session?.settings;
      for (const key of Object.keys(patch) as (keyof SettingsPatch)[]) {
        if (patch[key] !== undefined && actual?.[key] !== patch[key]) throw new BridgeFailure('Droid did not confirm every requested setting. The displayed settings are the values actually returned by Droid.');
      }
    });
  }

  async rename(title: string): Promise<void> {
    await this.mutate('Rename session', async scope => {
      if (!title.trim()) throw new BridgeFailure('Enter a non-empty session title.');
      result(await scope.client.renameSession({ title: title.trim() }, randomUUID()));
      await this.reload(scope);
    });
  }

  async fork(): Promise<void> {
    await this.mutate('Fork session', async scope => {
      const response = result(await scope.client.forkSession({}));
      await this.replace(scope, response.newSessionId);
    });
  }

  async compact(instructions?: string): Promise<void> {
    await this.mutate('Compact session', async scope => {
      const response = result(await scope.client.compactSession(instructions?.trim() ? { customInstructions: instructions } : {}));
      await this.replace(scope, response.newSessionId);
      this.state.notice = `Droid compacted the conversation${typeof response.removedCount === 'number' ? ` (${response.removedCount} messages removed)` : ''}.`;
    });
  }

  async prepareRewind(messageId: string): Promise<RewindPlan> {
    let plan!: RewindPlan;
    await this.mutate('Inspect rewind', async scope => {
      if (!this.state.messages.some(message => message.id === messageId && message.role === 'user')) throw new BridgeFailure('Choose a user message in the current session as the rewind target.');
      const info = result(await scope.client.getRewindInfo({ messageId }));
      const restores = Array.isArray(info.availableFiles) ? info.availableFiles : [];
      const deletes = Array.isArray(info.createdFiles) ? info.createdFiles : [];
      plan = {
        messageId,
        filesToRestore: restores.map(value => { const item = record(value); if (typeof item.filePath !== 'string' || typeof item.contentHash !== 'string' || typeof item.size !== 'number') throw new BridgeFailure('Droid returned an invalid file rewind plan.'); return { filePath: item.filePath, contentHash: item.contentHash, size: item.size }; }),
        filesToDelete: deletes.map(value => { const item = record(value); if (typeof item.filePath !== 'string') throw new BridgeFailure('Droid returned an invalid deletion plan.'); return { filePath: item.filePath }; }),
        unavailable: Array.isArray(info.evictedFiles) ? info.evictedFiles.map(value => { const item = record(value); return `${String(item.filePath ?? '')}: ${String(item.reason ?? 'Snapshot unavailable')}`; }) : [],
      };
      this.prepared = { scope, plan: structuredClone(plan) };
    });
    return plan;
  }

  async rewind(plan: RewindPlan, restoreFiles: boolean): Promise<void> {
    await this.mutate('Rewind session', async scope => {
      if (this.prepared?.scope !== scope || JSON.stringify(this.prepared.plan) !== JSON.stringify(plan)) throw new BridgeFailure('This rewind plan is stale or changed. Inspect the target again before confirming.');
      this.prepared = null;
      const response = result(await scope.client.executeRewind({ messageId: plan.messageId, filesToRestore: restoreFiles ? plan.filesToRestore : [], filesToDelete: restoreFiles ? plan.filesToDelete : [], forkTitle: this.state.session?.title ?? 'Rewound conversation' }));
      await this.replace(scope, response.newSessionId);
      const failedRestore = typeof response.failedRestoreCount === 'number' ? response.failedRestoreCount : 0;
      const failedDelete = typeof response.failedDeleteCount === 'number' ? response.failedDeleteCount : 0;
      this.state.notice = failedRestore || failedDelete ? `Conversation rewound, but Droid reported ${failedRestore} failed restores and ${failedDelete} failed deletions. Inspect the files before continuing.` : 'Droid rewound into a new session. The source session remains saved.';
    });
  }

  async close(): Promise<void> {
    const scope = this.scope;
    this.scope = null;
    this.operation = null;
    this.cancelTurn(scope, 'The bridge was closed. No prompt was replayed.');
    try { if (scope) await this.dispose(scope); }
    finally {
      if (!this.scope && !this.operation) { this.state.phase = 'disconnected'; this.state.approval = null; this.state.question = null; this.changed(); }
    }
  }

  private async connect(sessionId?: string): Promise<void> {
    const connection = this.sdk.create(this.options);
    const scope: Scope = {
      client: connection.client, id: null, targetId: sessionId ?? null, loading: true, events: [], cleanups: [], locks: new Map(), prompts: [], disposed: null,
      stopping: false, remoteBusy: false, connecting: null, revision: 0, permissionResults: new Map(), questionResults: new Map(), terminalIds: new Set(), unansweredSnapshots: new Set(),
    };
    this.scope = scope;
    this.bind(scope);
    try {
      if (sessionId) {
        const lock = await SessionLock.acquire(this.options.dataDir, sessionId);
        if (this.scope !== scope) { await lock.release(); throw new BridgeFailure('Session opening was cancelled.'); }
        scope.locks.set(sessionId, lock);
      }
      if (this.scope !== scope) throw new BridgeFailure('Session opening was cancelled.');
      scope.connecting = connection.connect();
      await scope.connecting;
      if (this.scope !== scope) throw new BridgeFailure('Session opening was cancelled.');
      const response = sessionId
        ? result(await scope.client.loadSession({ sessionId, loadAllMessages: true }))
        : result(await scope.client.initializeSession({ machineId: 'tern-bridge-droid', cwd: this.options.cwd }));
      if (this.scope !== scope) throw new BridgeFailure('Session opening was cancelled.');
      const id = sessionId ?? response.sessionId;
      if (typeof id !== 'string') throw new BridgeFailure('Droid did not return a session ID.');
      if (!scope.locks.has(id)) {
        const lock = await SessionLock.acquire(this.options.dataDir, id);
        if (this.scope !== scope) { await lock.release(); throw new BridgeFailure('Session opening was cancelled.'); }
        scope.locks.set(id, lock);
      }
      if (this.scope !== scope) throw new BridgeFailure('Session opening was cancelled.');
      scope.id = id; scope.targetId = id;
      this.install(scope, response, !sessionId);
      try {
        const discovered = result(await scope.client.listModels());
        if (this.scope === scope) this.state.models = normalizeModels(discovered.models, this.state.session?.settings);
      } catch (error) {
        if (this.scope === scope) this.state.notice = failure(error, 'Discover models').message;
      }
      await this.context(scope);
      this.changed();
    } catch (error) {
      if (this.scope === scope) this.scope = null;
      await this.dispose(scope);
      throw error;
    }
  }

  private bind(scope: Scope): void {
    const revision = ++scope.revision;
    for (const cleanup of scope.cleanups.splice(0)) cleanup();
    scope.cleanups.push(scope.client.onNotification(event => { if (scope.revision === revision) this.notification(scope, event); }));
    scope.cleanups.push(scope.client.onError(error => {
      if (this.scope !== scope || scope.revision !== revision) return;
      const problem = failure(error, 'Droid connection');
      this.state.error = problem.message; this.state.phase = 'error';
      this.transcript.finish('interrupted'); this.cancelPrompts(scope); this.active?.settle(problem); this.changed();
    }));
    scope.client.setPermissionHandler(event => scope.revision === revision ? this.permission(scope, event) : { selectedOption: ToolConfirmationOutcome.Cancel });
    scope.client.setAskUserHandler(event => scope.revision === revision ? this.question(scope, event) : { cancelled: true, answers: [] });
  }

  private install(scope: Scope, response: Record<string, unknown>, created = false): void {
    if (this.scope !== scope || !scope.id) return;
    const session = record(response.session);
    this.transcript = new Transcript();
    this.transcript.hydrate(session.messages);
    this.state.messages = this.transcript.messages;
    this.state.session = {
      id: scope.id,
      title: typeof session.title === 'string' ? session.title : '',
      cwd: typeof response.cwd === 'string' ? response.cwd : typeof session.cwd === 'string' ? session.cwd : created ? this.options.cwd : '',
      settings: settings(response.settings),
    };
    this.state.models = normalizeModels(response.availableModels, this.state.session.settings);
    this.state.context = null; this.state.usage = null;
    this.usage(response.tokenUsage);
    scope.remoteBusy = typeof response.workingState === 'string'
      ? response.workingState !== 'idle' : response.isAgentLoopInProgress === true;
    this.state.phase = scope.remoteBusy ? 'running' : 'idle';
    if (response.hasOlderMessages === true) this.state.notice = 'Droid returned a partial transcript despite loadAllMessages. The CLI must provide full history before it can all be displayed.';
    scope.loading = false;
    const buffered = scope.events.splice(0);
    for (const event of buffered) this.notification(scope, event);
    const pendingSnapshots = [
      ...(Array.isArray(response.pendingPermissions) ? response.pendingPermissions : []),
      ...(Array.isArray(response.pendingAskUserRequests) ? response.pendingAskUserRequests : []),
    ];
    scope.unansweredSnapshots.clear();
    for (const value of pendingSnapshots) {
      const id = record(value).requestId;
      if (typeof id === 'string' && !scope.prompts.some(prompt => prompt.id === id) && !scope.permissionResults.has(id) && !scope.questionResults.has(id)) scope.unansweredSnapshots.add(id);
    }
    if (scope.unansweredSnapshots.size) { this.state.notice = PENDING_SNAPSHOT_NOTICE; this.state.error = PENDING_SNAPSHOT_NOTICE; this.state.phase = 'error'; }
    this.showPrompt(scope);
  }

  private notification(scope: Scope, value: unknown): void {
    if (this.scope !== scope) return;
    const params = record(record(value).params);
    const event = record(params.notification);
    if (typeof event.type !== 'string') return;
    const id = typeof params.sessionId === 'string' ? params.sessionId : typeof event.sessionId === 'string' ? event.sessionId : null;
    if (scope.loading) {
      if (!id || !scope.targetId || id === scope.targetId) scope.events.push(value);
      return;
    }
    if (id && id !== scope.id) {
      // Public SDK notifications do not distinguish successor sessions from
      // subagents. Foreign envelopes never mutate this session or its settings.
      return;
    }
    this.transcript.apply(event);
    if (event.type === 'create_message') {
      const message = record(event.message);
      const turn = this.active;
      if (turn?.scope === scope && !turn.accepted && typeof message.id === 'string' && message.role === 'user' &&
          message.visibility !== 'llm_only' && message.isUserVisible !== false && message.hiddenFromUserViews !== true &&
          Array.isArray(message.content) && message.content.some(value => record(value).type === 'text') &&
          (message.id === turn.messageId || event.requestId === turn.requestId)) {
        turn.accepted = true;
        // Acceptance is tied to Droid's persisted message, never the send RPC.
        try { turn.accept(); } catch { this.state.notice = 'Droid accepted the message, but the editor could not acknowledge it.'; }
      }
    } else if (event.type === 'settings_updated' && this.state.session) {
      this.state.session.settings = settings(event.settings, this.state.session.settings);
      this.state.models = normalizeModels(this.state.models.map(model => ({ id: model.id, displayName: model.label, supportedReasoningEfforts: model.reasoningEfforts, defaultReasoningEffort: model.defaultReasoningEffort })), this.state.session.settings);
    } else if (event.type === 'session_title_updated' && this.state.session && typeof event.title === 'string') this.state.session.title = event.title;
    else if (event.type === 'session_working_directory_changed' && this.state.session && typeof event.cwd === 'string') this.state.session.cwd = event.cwd;
    else if (event.type === 'session_token_usage_changed') this.usage(event.tokenUsage);
    else if (event.type === 'permission_resolved' && typeof event.requestId === 'string') {
      const index = scope.prompts.findIndex(prompt => prompt.id === event.requestId && prompt.kind === 'approval');
      const prompt = scope.prompts[index];
      if (index >= 0 && prompt?.kind === 'approval') { scope.prompts.splice(index, 1); prompt.settle({ selectedOption: ToolConfirmationOutcome.Cancel }); }
    } else if (event.type === 'error') {
      this.state.error = failure({ name: event.errorType }, 'Droid turn').message;
      this.state.notice = this.state.error;
      // A normal Droid error can be followed by a real terminal result. Keep
      // this turn guarded until that result/idle or a transport failure arrives.
    } else if (event.type === 'droid_working_state_changed') {
      if (event.newState === 'idle') {
        scope.remoteBusy = false;
        if (scope.stopping) this.complete(scope, 'cancelled');
        else if (!this.active && !this.operation) this.state.phase = this.state.error ? 'error' : 'idle';
      } else if (typeof event.newState === 'string') {
        scope.remoteBusy = true;
        if (scope.stopping) return;
        if (this.state.phase !== 'stopping') this.state.phase = 'running';
      }
    } else if (event.type === 'agent_turn_completed') {
      const turn = this.active?.scope === scope && !this.active.completed ? this.active : null;
      if (typeof event.turnId !== 'string') {
        if (turn) {
          const problem = new BridgeFailure('Droid ended a local turn without its required turn ID. Nothing was replayed. Stop or reopen the session before continuing.');
          this.state.error = problem.message; this.state.phase = 'error';
          this.cancelPrompts(scope); turn.settle(problem); this.changed();
          return;
        }
        if (!scope.remoteBusy && !scope.stopping) return;
      } else {
        if (scope.terminalIds.has(event.turnId) || (turn && event.turnId !== turn.messageId)) return;
        if (!turn && !scope.remoteBusy && !scope.stopping) return;
        scope.terminalIds.add(event.turnId);
      }
      this.usage(event.cumulativeTokenUsage ?? event.tokenUsage);
      this.complete(scope, typeof event.reason === 'string' ? event.reason : 'error');
    }
    this.showPrompt(scope);
    this.changed();
  }

  private complete(scope: Scope, reason: string): void {
    if (this.scope !== scope) return;
    const interrupted = reason === 'cancelled' || reason === 'permission_rejected';
    const success = reason === 'completed' || reason === 'spec_handoff';
    this.transcript.finish(interrupted ? 'interrupted' : success ? 'done' : 'error');
    this.cancelPrompts(scope);
    scope.stopping = false;
    scope.remoteBusy = false;
    if (this.active?.scope === scope) scope.terminalIds.add(this.active.messageId);
    scope.unansweredSnapshots.clear();
    if (this.state.error === PENDING_SNAPSHOT_NOTICE) this.state.error = null;
    this.state.phase = success || interrupted ? 'idle' : 'error';
    if (interrupted) this.state.notice = 'Droid stopped. Partial messages have been preserved.';
    if (!success && !interrupted) {
      const reasons: Record<string, string> = {
        model_authentication_failed: 'Model authentication failed. Check the existing Droid CLI login or provider configuration.',
        model_usage_exhausted: 'The selected model has no remaining usage. Choose a model explicitly or check account limits.',
        model_provider_unreachable: 'The model provider could not be reached. Nothing was resubmitted.',
        model_rate_limited: 'The provider rate limited this turn. Nothing was resubmitted.',
        no_approver_available: 'Droid could not reach an approver. Reopen the session before continuing.',
        completion_persistence_failed: 'Droid could not persist the completed turn. Inspect the saved session before sending again.',
      };
      this.state.error = reasons[reason] ?? this.state.error ?? 'Droid ended the turn with an error. Partial messages are preserved; no prompt was replayed.';
    }
    if (success) this.state.error = null;
    if (this.active?.scope === scope) this.active.settle(this.state.phase === 'error' ? new BridgeFailure(this.state.error ?? 'Droid turn failed.') : undefined);
    void this.context(scope);
    this.changed();
  }

  private permission(scope: Scope, value: unknown): Promise<PermissionResult> {
    if (this.scope !== scope || scope.stopping || scope.disposed) return Promise.resolve({ selectedOption: ToolConfirmationOutcome.Cancel });
    const event = record(value); const params = record(event.params);
    const options = Array.isArray(params.options) ? params.options.map(value => record(value)) : [];
    const uses = Array.isArray(params.toolUses) ? params.toolUses.map(value => record(value)) : [];
    const details: string[] = []; const plans: string[] = []; const names: string[] = [];
    for (const use of uses) {
      const tool = record(use.toolUse); const detail = record(use.details);
      if (typeof tool.name === 'string') names.push(tool.name);
      for (const key of ['title', 'filePath', 'fullCommand', 'command', 'impactLevel', 'riskLevelReason', 'reason', 'target', 'serverName', 'toolName', 'patchContent', 'oldContent', 'newContent', 'content', 'questionnaire', 'proposal']) {
        if (typeof detail[key] === 'string') details.push(`${key}: ${detail[key]}`);
      }
      if (typeof detail.plan === 'string') plans.push(detail.plan);
      if (Array.isArray(detail.files)) for (const file of detail.files) {
        const item = record(file);
        details.push(['operation', 'filePath', 'moveTo', 'oldContent', 'newContent'].filter(key => typeof item[key] === 'string').map(key => `${key}: ${item[key]}`).join('\n'));
      }
    }
    const id = typeof event.id === 'string' ? event.id : '';
    if (!id) return Promise.resolve({ selectedOption: ToolConfirmationOutcome.Cancel });
    scope.unansweredSnapshots.delete(id);
    const settled = scope.permissionResults.get(id);
    if (settled) return Promise.resolve(settled);
    const pending = scope.prompts.find(prompt => prompt.kind === 'approval' && prompt.id === id);
    if (pending?.kind === 'approval') return pending.promise;
    const { promise, resolve } = Promise.withResolvers<PermissionResult>();
    scope.prompts.push({ kind: 'approval', id, promise, settle(value) { scope.permissionResults.set(id, value); resolve(value); }, view: {
      id, title: names.join(', ') || 'Droid permission', detail: details.join('\n\n'), ...(plans.length ? { plan: plans.join('\n\n') } : {}),
      options: options.flatMap(option => typeof option.value === 'string' && typeof option.label === 'string' ? [{
        value: option.value, label: option.label,
        persistent: option.value.startsWith('proceed_always') || option.value.startsWith('proceed_auto_run'),
        ...(option.value.startsWith('proceed_new_session') ? { disabledReason: 'SDK 0.9.1 cannot authoritatively identify the new implementation session. Choose an offered current-session outcome, or cancel and use Fork explicitly.' } : {}),
      }] : []),
    } });
    this.showPrompt(scope); this.changed();
    return promise;
  }

  private question(scope: Scope, value: unknown): Promise<QuestionResult> {
    if (this.scope !== scope || scope.stopping || scope.disposed) return Promise.resolve({ cancelled: true, answers: [] });
    const event = record(value); const params = record(event.params);
    const id = typeof event.id === 'string' ? event.id : '';
    if (!id) return Promise.resolve({ cancelled: true, answers: [] });
    scope.unansweredSnapshots.delete(id);
    const questions = Array.isArray(params.questions) ? params.questions.flatMap(value => {
      const item = record(value);
      return typeof item.index === 'number' && typeof item.question === 'string' ? [{
        index: item.index, question: item.question,
        options: Array.isArray(item.options) ? item.options.filter((option): option is string => typeof option === 'string') : [],
        ...(typeof item.topic === 'string' ? { topic: item.topic } : {}),
        ...(typeof item.multiSelect === 'boolean' ? { multiSelect: item.multiSelect } : {}),
      }] : [];
    }) : [];
    const settled = scope.questionResults.get(id);
    if (settled) return Promise.resolve(settled);
    const pending = scope.prompts.find(prompt => prompt.kind === 'question' && prompt.id === id);
    if (pending?.kind === 'question') return pending.promise;
    const { promise, resolve } = Promise.withResolvers<QuestionResult>();
    scope.prompts.push({ kind: 'question', id, promise, settle(value) { scope.questionResults.set(id, value); resolve(value); }, view: { id, questions } });
    this.showPrompt(scope); this.changed();
    return promise;
  }

  private showPrompt(scope: Scope): void {
    if (this.scope !== scope) return;
    const prompt = scope.prompts[0];
    this.state.approval = prompt?.kind === 'approval' ? prompt.view : null;
    this.state.question = prompt?.kind === 'question' ? prompt.view : null;
    if (prompt && this.state.phase !== 'stopping') this.state.phase = prompt.kind;
    else if (scope.unansweredSnapshots.size && this.state.phase !== 'stopping') { this.state.phase = 'error'; this.state.error = PENDING_SNAPSHOT_NOTICE; }
    else if (this.state.phase === 'approval' || this.state.phase === 'question') this.state.phase = scope.remoteBusy || (this.active && !this.active.completed) ? 'running' : 'idle';
  }

  private cancelPrompts(scope: Scope): void {
    for (const prompt of scope.prompts.splice(0)) {
      if (prompt.kind === 'approval') prompt.settle({ selectedOption: ToolConfirmationOutcome.Cancel });
      else prompt.settle({ cancelled: true, answers: [] });
    }
    if (this.scope === scope) { this.state.approval = null; this.state.question = null; }
  }


  private async reload(scope: Scope): Promise<void> {
    if (!scope.id || this.scope !== scope) throw new BridgeFailure('The session changed before it could be loaded.');
    this.cancelPrompts(scope);
    scope.loading = true; scope.events.length = 0; scope.targetId = scope.id;
    try {
      const response = result(await scope.client.loadSession({ sessionId: scope.id, loadAllMessages: true }));
      if (this.scope !== scope) throw new BridgeFailure('The session changed while loading.');
      this.bind(scope); this.install(scope, response);
      await this.context(scope);
    } finally { scope.loading = false; }
  }

  private async replace(scope: Scope, id: unknown): Promise<void> {
    if (typeof id !== 'string' || !id) throw new BridgeFailure('Droid did not identify the replacement session. Open the session picker before continuing.');
    this.cancelPrompts(scope); this.prepared = null;
    const lock = await SessionLock.acquire(this.options.dataDir, id);
    if (this.scope !== scope) { await lock.release(); throw new BridgeFailure('The session was closed during replacement.'); }
    scope.locks.set(id, lock);
    const previous = scope.id;
    scope.permissionResults.clear(); scope.questionResults.clear(); scope.terminalIds.clear();
    scope.id = id;
    try {
      await this.reload(scope);
      if (previous && previous !== id) { await scope.locks.get(previous)?.release(); scope.locks.delete(previous); }
    } catch (error) {
      this.state.notice = `Droid saved a successor session: ${id}. Open that ID to recover its history. The source was not replayed.`;
      throw error;
    }
  }

  private async mutate(action: string, operation: (scope: Scope) => Promise<void>): Promise<void> {
    const scope = this.ready();
    if (scope.unansweredSnapshots.size) throw new BridgeFailure(PENDING_SNAPSHOT_NOTICE);
    if (this.operation || this.active || this.state.phase !== 'idle') throw new BridgeFailure('Wait for Droid to become idle before changing the session.');
    const token = Symbol(); this.operation = token; this.state.error = null;
    try { await operation(scope); }
    catch (error) { if (this.scope === scope) throw this.report(error, action); throw failure(error, action); }
    finally { if (this.operation === token) this.operation = null; this.changed(); }
  }

  private ready(): Scope {
    if (!this.scope?.id || !this.scope.client.isConnected || this.scope.loading) throw new BridgeFailure('Open a connected Droid session first.');
    return this.scope;
  }

  private async context(scope: Scope): Promise<void> {
    const revision = scope.revision;
    try {
      const info = result(await scope.client.getContextStats());
      if (this.scope === scope && scope.revision === revision && typeof info.used === 'number' && typeof info.limit === 'number') this.state.context = { used: info.used, limit: info.limit };
    } catch { /* Context accounting is optional SDK metadata; never invent it. */ }
    if (this.scope === scope) this.changed();
  }

  private usage(value: unknown): void {
    const info = record(value);
    if (typeof info.inputTokens === 'number' && typeof info.outputTokens === 'number') this.state.usage = { input: info.inputTokens, output: info.outputTokens };
  }

  private cancelTurn(scope: Scope | null, message: string): void {
    if (!scope) return;
    this.cancelPrompts(scope);
    if (this.active?.scope === scope) this.active.settle(new BridgeFailure(message));
    this.transcript.finish('interrupted'); this.prepared = null;
  }

  private async dispose(scope: Scope): Promise<void> {
    if (scope.disposed) return scope.disposed;
    scope.disposed = (async () => {
      this.cancelPrompts(scope);
      for (const cleanup of scope.cleanups.splice(0)) cleanup();
      scope.client.clearPermissionHandler(); scope.client.clearAskUserHandler();
      await scope.connecting?.catch(() => undefined);
      try { await scope.client.close(); }
      finally {
        const releases = await Promise.allSettled([...scope.locks.values()].map(lock => lock.release()));
        scope.locks.clear();
        if (releases.some(release => release.status === 'rejected')) throw new BridgeFailure('Droid closed, but a plugin session lock could not be removed. Check data-directory permissions before reopening that session.');
      }
    })();
    return scope.disposed;
  }

  private report(error: unknown, action: string): BridgeFailure {
    const problem = failure(error, action);
    this.state.error = problem.message; this.state.phase = 'error'; this.changed();
    return problem;
  }

  private changed(): void {
    const scope = this.scope;
    this.state.needsInterrupt = !!scope?.client.isConnected && (scope.stopping || scope.remoteBusy || !!scope.unansweredSnapshots.size || (this.active?.scope === scope && !this.active.completed));
    this.options.onChange();
  }
}
