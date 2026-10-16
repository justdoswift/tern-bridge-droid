import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Composer } from '@oh-my-pi/pi-tui/prompt/composer';
import { AttachmentChipsBand } from '@oh-my-pi/pi-tui/prompt/attachment-chips';
import { CombinedAutocompleteProvider } from '@oh-my-pi/pi-tui/autocomplete';
import { Text } from '@oh-my-pi/pi-tui/components/text';
import { ErrorBannerComponent } from '@oh-my-pi/pi-tui/overlays/error-banner';
import { node, span } from '@oh-my-pi/pi-tui/native/describe';
import { actionButton } from '@oh-my-pi/pi-tui/native/overlay';
import { onNativeRenderingChange } from '@oh-my-pi/pi-tui/native/state';
import { stopSharedSpinnerTicker } from '@oh-my-pi/pi-tui/chat/tool-execution';
import type { ComposerFacts } from '@oh-my-pi/pi-tui/status-line/types';
import type { Component } from '@oh-my-pi/pi-tui/tui';
import { DroidBridge } from './backend.js';
import type { Locale } from './contracts.js';
import { DroidTranscript } from './omp-transcript.js';
import { DroidDialogs } from './omp-dialogs.js';
import { DroidTodoHud } from './omp-todos.js';
import { DroidWorkingHud } from './omp-working.js';
import { isDroidWorking } from './work-state.js';
import { DroidImageComposer, imageAdmissionError, type ImageSubmission } from './omp-images.js';
import { dictionary } from './i18n.js';

const { values } = parseArgs({ options: {
  cwd: { type: 'string' }, 'data-dir': { type: 'string' }, droid: { type: 'string' },
  session: { type: 'string' }, 'pick-session': { type: 'boolean' }, locale: { type: 'string' },
  help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
} });
if (values.help || values.version) {
  process.stdout.write(values.version ? 'tern-bridge-droid 0.1.0\n' :
    'tern-bridge-droid — Droid with the original omp UI components\n\n' +
    'Usage: bun dist/client.mjs [--cwd DIR] [--data-dir DIR] [--session ID | --pick-session]\n' +
    '       [--droid PATH] [--locale zh-CN|en-US]\n\n' +
    'Requires Bun 1.3.14+, Tern native surfaces and an authenticated Droid CLI.\n' +
    'No model request is made until you send a message or explicitly compact context.\n');
} else await run();

async function run(): Promise<void> {
  if (values.locale && values.locale !== 'zh-CN' && values.locale !== 'en-US') throw new Error('--locale must be zh-CN or en-US');
  if (values.session && values['pick-session']) throw new Error('Choose --session or --pick-session, not both.');
  const cwd = resolve(values.cwd ?? process.cwd());
  const config = process.env.TERN_CONFIG_DIR ?? (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Tern')
    : join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'tern'));
  const dataDir = resolve(values['data-dir'] ?? join(config, 'plugin-data', 'tern-bridge-droid'));
  let preferences: Record<string, unknown> = {};
  try {
    const saved: unknown = JSON.parse(await readFile(join(dataDir, 'preferences.json'), 'utf8'));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) preferences = saved as Record<string, unknown>;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  let locale: Locale = values.locale === 'en-US' || (!values.locale && preferences.locale === 'en-US') ? 'en-US' : 'zh-CN';
  const text = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  if (process.env.TERM_PROGRAM?.toLowerCase() !== 'tern' || !process.stdin.isTTY) {
    process.stderr.write(text('请在 Tern 的本机窗格中打开此客户端。\n', 'Open this client in a local Tern pane.\n'));
    process.exitCode = 1;
    return;
  }
  // Neither the Droid wire log nor the shared UI's opt-in TSP recorder may copy conversations.
  delete process.env.FACTORY_DROID_SDK_TRANSPORT_LOG;
  delete process.env.PI_TUI_TSP_RECORD;
  process.title = 'tern-bridge-droid';
  const ended = Promise.withResolvers<void>();
  let closing = false;
  let scheduled = false;
  let submitting = false;
  let terminalProgress = false;
  let pendingNew: string | null = null;
  let uiError: string | null = null;
  let observedBackendError: string | null = null;
  let dismissedBackendError: string | null = null;
  let banner: ErrorBannerComponent | undefined;
  let bannerMessage: string | null = null;
  let mountedPrompt: Component | undefined;
  let facts: ComposerFacts;
  let factsKey = '';
  let expanded = false;
  let autocompleteCwd = '';
  const notice = new Text('');
  const identity = new Text('Droid');
  const composer = new Composer({ preferences: { quiet: true, spellingAutocomplete: 'off', spellingTypoDetection: false }, exit: code => { process.exitCode = code; void shutdown(); } });
  const backend = new DroidBridge({ cwd, dataDir, execPath: values.droid ?? (typeof preferences.droidPath === 'string' ? preferences.droidPath : undefined), onChange: changed });
  const transcript = new DroidTranscript(composer.ui, cwd);
  const todos = new DroidTodoHud();
  const working = new DroidWorkingHud(todos);
  const dialogs = new DroidDialogs(composer, backend, { locale: () => locale, onError: report, onChange: changed, openSession: id => open(id) });
  composer.setHeaderExtras([identity], []);
  composer.editor.magicKeywordsEnabledOverride = false;
  composer.editor.attachmentChips = new AttachmentChipsBand(composer.editor, composer.ui.imageBudget, () => composer.ui.requestRender());
  composer.editor.composerState = () => ({ running: busy(), thinking: backend.state.session?.settings.reasoningEffort, title: backend.state.session?.title || undefined });
  composer.editor.composerFacts = {
    describeComposerFacts: () => facts,
    handleNativeEvent(event) {
      if (event.type === 'action' && event.act.startsWith('status.')) void perform(() => command(event.act.slice(7)));
    },
  };
  const images = new DroidImageComposer(composer.editor, {
    locale: () => locale, currentSession: () => backend.state.session?.id ?? null,
    cwd: () => backend.state.session?.cwd ?? cwd, onChange: changed, onError: report,
    onSubmit: submission => { void perform(() => submit(submission)); },
  });
  composer.editor.onEscape = () => { void perform(() => busy() ? backend.interrupt() : Promise.resolve()); };
  composer.editor.onClear = () => {
    if (busy()) void perform(() => backend.interrupt());
    else composer.editor.clearDraft();
  };
  composer.editor.onExit = () => { void perform(() => command('quit')); };
  composer.editor.onSelectModel = composer.editor.onSelectModelTemporary = () => { void perform(() => command('model')); };
  composer.editor.onCycleThinkingLevel = () => { void perform(() => command('reasoning')); };
  composer.editor.onRetry = () => { void perform(() => command('retry')); };
  composer.editor.setCustomKeyHandler('ctrl+alt+shift+o', () => { void perform(() => dialogs.sessions()); });
  composer.editor.setCustomKeyHandler('ctrl+alt+shift+n', () => { void perform(() => command('new')); });
  composer.editor.setCustomKeyHandler('ctrl+o', () => { expanded = !expanded; transcript.setExpanded(expanded); changed(); });
  const commands = [
    { name: 'new', description: 'Droid: new conversation' }, { name: 'resume', description: 'Droid: saved conversations' },
    { name: 'model', description: 'Droid: select model' }, { name: 'reasoning', description: 'Droid: reasoning effort' },
    { name: 'mode', description: 'Droid: Auto / Spec' }, { name: 'autonomy', description: 'Droid: approval policy' },
    { name: 'rename', description: 'Droid: rename conversation' }, { name: 'fork', description: 'Droid: fork conversation' },
    { name: 'compact', description: 'Droid: compact context (may use model quota)' }, { name: 'rewind', description: 'Droid: inspect rewind' },
    { name: 'context', description: 'Droid: context usage breakdown' },
    { name: 'retry', description: 'Droid: reconnect without replay' }, { name: 'language', description: 'Bridge: 中文 / English' },
    { name: 'help', description: 'Bridge: conversation actions' }, { name: 'quit', description: 'Bridge: close client' },
  ];
  const nativeChange = onNativeRenderingChange(on => { if (on) composer.ui.terminal.setTitle('Droid'); });

  function busy(): boolean {
    return submitting || backend.state.needsInterrupt || ['connecting', 'running', 'approval', 'question', 'stopping'].includes(backend.state.phase);
  }
  function report(error: unknown): void {
    if (closing) return;
    uiError = imageAdmissionError(error, locale) ?? (error instanceof Error ? error.message : String(error));
    pendingNew = null;
    changed();
  }
  async function perform(work: () => Promise<void>): Promise<void> {
    uiError = null;
    try { await work(); } catch (error) { report(error); }
    changed();
  }
  function changed(): void {
    if (closing || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (closing) return;
      try { update(); } catch {
        process.exitCode = 1;
        process.stderr.write('Droid UI rendering failed. Saved messages were not replayed. Reopen the saved session.\n');
        void shutdown();
        return;
      }
      if (pendingNew) {
        if (backend.state.session?.id !== pendingNew || backend.state.phase === 'error') pendingNew = null;
        else if (!busy() && backend.state.phase === 'idle') { pendingNew = null; void perform(() => open()); }
      }
    });
  }
  function update(): void {
    const active = isDroidWorking(backend.state);
    if (terminalProgress !== active) {
      terminalProgress = active;
      composer.ui.terminal.setProgress(active);
    }
    const b = backend.state;
    const t = dictionary(locale);
    const activeCwd = b.session?.cwd || cwd;
    if (activeCwd !== autocompleteCwd) {
      autocompleteCwd = activeCwd;
      composer.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, activeCwd));
    }
    if (b.error !== observedBackendError) { observedBackendError = b.error; dismissedBackendError = null; }
    const error = uiError || (b.error === dismissedBackendError ? null : b.error);
    if (error !== bannerMessage) {
      banner?.dispose();
      bannerMessage = error;
      banner = error ? new ErrorBannerComponent(error, () => { uiError = null; dismissedBackendError = b.error; changed(); }) : undefined;
    }
    identity.setText(`Droid · ${b.session?.title || t.untitled}`);
    notice.setText(b.notice ?? '');
    transcript.sync(b);
    todos.sync(b, locale);
    working.sync(b, locale);
    const prompt = dialogs.syncPrompts();
    composer.editor.disableSubmit = submitting || ['connecting', 'running', 'approval', 'question', 'stopping'].includes(b.phase) || b.needsInterrupt;
    composer.setRuntimeChildren([transcript.container, ...(banner ? [banner] : []), ...(b.notice ? [notice] : []), working, prompt ?? composer.editor]);
    if (prompt !== mountedPrompt) {
      mountedPrompt = prompt;
      if (!dialogs.hasOverlay()) composer.ui.setFocus(prompt ?? composer.editor);
    }
    const settings = b.session?.settings;
    const selected = b.models.find(model => model.id === settings?.modelId);
    const key = JSON.stringify([locale, b.phase, b.context, b.usage, b.session?.title, selected?.label, settings]);
    if (key !== factsKey) {
      factsKey = key;
      // Keep recovery reachable when native width compression hides optional extras.
      const segments = ['error', 'disconnected'].includes(b.phase)
        ? [{ key: 'retry', label: t.reconnect, title: t.reconnectHint }] : [
        { key: 'sessions', label: t.sessions, title: t.sessions }, { key: 'more', label: t.more, title: t.more },
        { key: 'mode', label: settings?.interactionMode || t.mode, title: `${t.mode}: ${settings?.interactionMode || t.unknown}` },
        { key: 'autonomy', label: settings?.autonomyLevel || t.autonomy, title: `${t.autonomy}: ${settings?.autonomyLevel || t.unknown}` },
      ];
      facts = {
        context: node('meter', { role: 'omp.composer.context', style: 'bar', actions: { click: 'status.context' }, aria: t.context,
          value: b.context && b.context.limit > 0 ? Math.min(1, b.context.used / b.context.limit) : null,
          ...(b.context && b.context.limit > 0 ? { label: `${Math.round(b.context.used / b.context.limit * 100)}%` } : {}),
          title: `${t.context}: ${b.context ? `${b.context.used.toLocaleString(locale)} / ${b.context.limit.toLocaleString(locale)}` : t.unknown}` }, undefined, 'context'),
        model: { spans: [span(`Droid · ${selected?.label || settings?.modelId || t.default}`)], title: t.model },
        extras: node('row', { role: 'omp.composer.extras', grow: 1, gap: 'xs', align: 'center', wrap: true },
          segments.map(item => actionButton(item.label, `status.${item.key}`, { key: item.key, title: item.title })), 'extras'),
        usage: node('text', { role: 'omp.composer.usage', text: b.usage ? `${b.usage.input.toLocaleString(locale)} ${t.input} · ${b.usage.output.toLocaleString(locale)} ${t.output}` : '', title: t.usage, wrap: 'none' }, undefined, 'usage'),
      };
    }
    composer.ui.terminal.setTitle(`Droid · ${b.session?.title || t.untitled}`);
    composer.ui.requestRender();
  }
  async function open(id?: string): Promise<void> {
    pendingNew = null;
    if (busy()) throw new Error(text('请先停止当前任务，再切换会话。', 'Stop the active turn before switching conversations.'));
    if (id !== undefined && id === backend.state.session?.id) {
      await backend.open(id);
      return;
    }
    const transition = images.beginSessionChange();
    try { await backend.open(id); transition.complete(); }
    catch (error) { transition.rollback(); throw error; }
    // Input typed during connection belongs to the selected session. Live backend
    // prompts and the selector own focus; opening never redirects it to a hidden editor.
  }
  async function submit(submission: ImageSubmission): Promise<void> {
    const message = submission.text;
    if (!message.trim() && !submission.images.length) return;
    const match = !submission.images.length && /^\/([a-z-]+)(?:\s+([\s\S]*))?$/.exec(message);
    if (match && match[1] && commands.some(item => item.name === match[1])) {
      images.accept(submission);
      await command(match[1], match[2]);
      return;
    }
    if (busy() || backend.state.phase !== 'idle') throw new Error(text('当前无法发送。请先停止任务或重新连接会话。', 'Cannot send now. Stop the active work or reconnect the session.'));
    submitting = true;
    changed();
    try {
      await backend.send(message, () => { images.accept(submission); changed(); }, submission.images);
    } finally { submitting = false; changed(); }
  }
  async function command(name: string, argument?: string): Promise<void> {
    const t = dictionary(locale);
    switch (name) {
      case 'sessions': return dialogs.sessions();
      case 'context': return dialogs.context();
      case 'resume': return argument?.trim() ? open(argument.trim()) : dialogs.sessions();
      case 'more': case 'help': {
        const selected = await dialogs.choose(text('Droid 会话操作', 'Droid conversation actions'), commands.filter(item => item.name !== 'help').map(item => ({ value: item.name, label: `/${item.name}`, description: item.description })));
        if (selected) await command(selected);
        return;
      }
      case 'new': {
        if (busy()) {
          if (!await dialogs.confirm(text('停止并新建对话？', 'Stop and start a new conversation?'), text('已执行的文件修改不会自动撤销。', 'File changes already made will not be undone.'))) return;
          const source = backend.state.session?.id;
          await backend.interrupt();
          if (source && backend.state.session?.id === source) pendingNew = source;
          changed();
        } else await open();
        return;
      }
      case 'model': {
        const value = await dialogs.choose(t.model, backend.state.models.map(model => ({ value: model.id, label: model.label, description: model.id })));
        if (value) await backend.updateSettings({ modelId: value });
        return;
      }
      case 'reasoning': {
        const model = backend.state.models.find(item => item.id === backend.state.session?.settings.modelId);
        const value = await dialogs.choose(t.reasoning, (model?.reasoningEfforts ?? []).map(value => ({ value, label: value })));
        if (value) await backend.updateSettings({ reasoningEffort: value });
        return;
      }
      case 'mode': {
        const value = await dialogs.choose(t.mode, [{ value: 'auto', label: 'Auto', description: text('执行任务，保留当前审批策略。', 'Execute with the current approval policy.') }, { value: 'spec', label: 'Spec', description: text('只读分析并提出方案；切换模式不代表接受计划。', 'Inspect and propose a plan; switching mode does not accept a plan.') }]);
        if (value) await backend.updateSettings({ interactionMode: value });
        return;
      }
      case 'autonomy': {
        const settings = backend.state.session?.settings;
        const levels = settings?.availableAutonomyLevels ?? (settings?.autonomyLevel ? [settings.autonomyLevel] : []);
        const value = await dialogs.choose(t.autonomy, levels.map(value => ({ value, label: value })));
        if (value && (value === 'off' || await dialogs.confirm(t.autonomy, text(`Droid 将按 ${value} 级别自动批准之后的操作。`, `Droid will automatically approve subsequent operations allowed by ${value}.`)))) await backend.updateSettings({ autonomyLevel: value });
        return;
      }
      case 'rename': {
        const value = argument ?? await dialogs.input(t.rename, backend.state.session?.title, t.renameHint);
        if (value?.trim()) await backend.rename(value);
        return;
      }
      case 'fork': return backend.fork();
      case 'compact': {
        const value = await dialogs.input(t.compact, argument, text('压缩可能调用模型并消耗当前 Droid 额度。可填写额外要求。', 'Compaction may call the selected model and use Droid quota. Extra instructions are optional.'));
        if (value !== undefined) await backend.compact(value || undefined);
        return;
      }
      case 'rewind': {
        const messages = backend.state.messages.filter(message => message.role === 'user');
        const target = await dialogs.choose(t.rewind, messages.map(message => ({ value: message.id, label: message.blocks.flatMap(block => block.kind === 'text' ? [block.text] : []).join('\n') || t.user, description: message.id })));
        if (!target) return;
        const plan = await backend.prepareRewind(target);
        const details = [t.rewindDetail, ...plan.filesToRestore.map(file => `${t.restore}: ${file.filePath} (${file.size} B)`), ...plan.filesToDelete.map(file => `${t.remove}: ${file.filePath}`), ...plan.unavailable.map(file => `${t.unavailable}: ${file}`)].join('\n');
        const choice = await dialogs.choose(t.rewindConfirm, [
          { value: 'conversation', label: t.conversationOnly, description: details },
          { value: 'files', label: t.restoreFiles, description: details, ...((plan.unavailable.length || (!plan.filesToRestore.length && !plan.filesToDelete.length)) ? { disabledReason: plan.unavailable.length ? t.unavailableHint : t.noFiles } : {}) },
        ]);
        if (choice && await dialogs.confirm(t.rewindConfirm, details)) await backend.rewind(plan, choice === 'files');
        return;
      }
      case 'retry': await backend.open(backend.state.session?.id); return;
      case 'language': {
        const value = argument ?? await dialogs.choose(t.language, [{ value: 'zh-CN', label: '简体中文' }, { value: 'en-US', label: 'English' }]);
        if (value !== 'zh-CN' && value !== 'en-US') return;
        await mkdir(dataDir, { recursive: true, mode: 0o700 });
        const path = join(dataDir, 'preferences.json');
        const pending = `${path}.${process.pid}.tmp`;
        await writeFile(pending, JSON.stringify({ ...preferences, locale: value }) + '\n', { mode: 0o600 });
        await rename(pending, path);
        preferences = { ...preferences, locale: value }; locale = value; factsKey = '';
        return;
      }
      case 'quit':
        if ((busy() || composer.editor.getText()) && !await dialogs.confirm(text('关闭客户端？', 'Close the client?'), text('会停止当前任务，未发送草稿不会保存；历史会话保留。', 'The active turn will stop and unsent drafts will be lost. Saved conversations remain.'))) return;
        return shutdown();
    }
  }
  async function shutdown(): Promise<void> {
    if (closing) return;
    closing = true;
    pendingNew = null;
    composer.ui.terminal.setProgress(false);
    dialogs.dispose();
    images.dispose();
    try { await backend.close(); }
    finally {
      nativeChange(); transcript.dispose(); stopSharedSpinnerTicker(); composer.stop(); ended.resolve();
    }
  }
  const signal = () => { void shutdown(); };
  for (const signalName of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signalName, signal);
  try {
    update();
    composer.start({ clearScrollback: false, playWelcomeIntro: false, deferInput: true });
    composer.ui.releaseHeldInput();
    if (values['pick-session']) void perform(() => dialogs.sessions());
    else void perform(() => backend.open(values.session));
    await ended.promise;
  } finally {
    for (const signalName of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.off(signalName, signal);
    await shutdown();
  }
}
