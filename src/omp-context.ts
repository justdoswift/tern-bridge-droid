import { Text } from '@oh-my-pi/pi-tui/components/text';
import { ContextUsageView, type ContextBreakdown } from '@oh-my-pi/pi-tui/status-line/context-usage';
import { ReportPanel } from '@oh-my-pi/pi-tui/overlays/report-panel';
import { actionBar, actionButton } from '@oh-my-pi/pi-tui/native/overlay';
import { col, node, span, text } from '@oh-my-pi/pi-tui/native/describe';
import type { DescribeContext, NativeNode, NativeUiEvent } from '@oh-my-pi/pi-tui/native/node';
import type { Component } from '@oh-my-pi/pi-tui/tui';
import { theme } from '@oh-my-pi/pi-tui/theme';
import type { ContextDetails, Locale } from './contracts.js';
import { dictionary } from './i18n.js';

/** Original context view, with Droid's category taxonomy and no invented compaction policy. */
export class DroidContextView extends ContextUsageView {
  private projected?: { original: NativeNode; node: NativeNode };

  constructor(private readonly details: ContextDetails, private readonly locale: Locale) {
    const t = dictionary(locale);
    const categories = {
      systemPrompt: [t.contextSystemPrompt, 'accent'], systemTools: [t.contextSystemTools, 'warning'],
      mcpTools: [t.contextMcpTools, 'warning'], userInfo: [t.contextUserInfo, 'customMessageLabel'],
      agentsMd: [t.contextAgentsMd, 'customMessageLabel'], customAgents: [t.contextDroids, 'customMessageLabel'],
      skills: [t.contextSkills, 'success'], messages: [t.contextMessages, 'userMessageText'],
    } as const;
    super({
      model: undefined, contextWindow: details.contextBudget, usedTokens: details.usedTokens,
      freeTokens: details.freeTokens, autoCompactBufferTokens: 0,
      categories: details.categories.map((category, index) => ({
        // In the pinned omp view this closed type is only an opaque sibling key.
        // Droid has eight categories, not omp's five; retain each one separately.
        id: `droid-${index}` as ContextBreakdown['categories'][number]['id'],
        label: locale === 'zh-CN' ? categories[category.colorKey][0] : category.name,
        tokens: category.tokens, color: categories[category.colorKey][1], glyph: '■',
      })),
    }, theme);
  }

  override describe(cx: DescribeContext): NativeNode {
    const t = dictionary(this.locale);
    if (!(this.details.contextBudget > 0)) return text(t.contextUnavailable);
    const original = super.describe(cx);
    if (this.projected?.original === original) return this.projected.node;
    const count = (value: number) => value.toLocaleString(this.locale);
    const percent = new Intl.NumberFormat(this.locale, { style: 'percent', maximumFractionDigits: 1 });
    const project = (source: NativeNode): NativeNode => {
      const children = source.c?.map(child => 'k' in child ? project(child) : child);
      if (source.k === 'text' && source.p?.role === 'omp.context.used') return {
        ...source, p: { ...source.p, spans: [span(count(this.details.usedTokens), 'strong'),
          span(` / ${count(this.details.contextBudget)} tokens · ${percent.format(this.details.usedTokens / this.details.contextBudget)}`, 'dim')] },
      };
      if (source.k === 'text' && source.p?.role === 'omp.context.room') return {
        ...source, p: { ...source.p, text: `${t.contextFree}: ${count(this.details.freeTokens)}` },
      };
      if (source.k === 'row' && source.p?.role === 'omp.context.cat.free') return {
        ...source, p: { ...source.p, title: `${t.contextFree} · ${count(this.details.freeTokens)} tokens` },
        c: children?.map(child => 'k' in child && child.k === 'text' && child.p?.role === 'omp.context.label'
          ? { ...child, p: { ...child.p, text: t.contextFree } } : child),
      };
      if (source.k === 'meter' && source.p) return {
        ...source, p: { ...source.p, aria: t.context,
          parts: source.p?.parts?.map(part => part.token === 'track'
            ? { ...part, label: `${t.contextFree} · ${count(this.details.freeTokens)} tokens` } : part) },
      };
      return { ...source, ...(children ? { c: children } : {}) };
    };
    const projected = col([project(original), text(t.contextThresholdUnknown, { role: 'omp.context.snap.note' })], { gap: 'md' });
    this.projected = { original, node: projected };
    return projected;
  }
}

export class DroidContextLoading extends Text {
  private readonly native: NativeNode;
  constructor(locale: Locale) {
    const label = dictionary(locale).contextLoading;
    super(label, 0, 0);
    this.native = node('row', { gap: 'sm', align: 'center' }, [node('spinner', {}), text(label)]);
  }
  override describe(): NativeNode { return this.native; }
}

/** Keep ReportPanel's scrolling, Close/Esc handling and single native sheet. */
export class DroidContextReport extends ReportPanel {
  private projected?: { original: NativeNode; node: NativeNode };
  constructor(title: string, body: Component, private readonly locale: Locale, close: () => void, private readonly retry?: () => void) {
    super({ title, body, closeKey: 'Esc', onClose: close });
    this.holdFocus();
  }
  override describe(): NativeNode {
    const original = super.describe();
    if (this.projected?.original === original) return this.projected.node;
    const t = dictionary(this.locale);
    const projected: NativeNode = { ...original, c: [original.c![0]!,
      actionBar([...(this.retry ? [actionButton(t.retry, 'context.retry')] : []), null,
        actionButton(t.close, 'close', { keys: 'escape' })]),
    ] };
    this.projected = { original, node: projected };
    return projected;
  }
  override handleNativeEvent(event: NativeUiEvent): void {
    if (event.type === 'action' && event.act === 'context.retry') this.retry?.();
    else super.handleNativeEvent(event);
  }
}
