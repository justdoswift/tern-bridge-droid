import { WelcomeComponent } from '@oh-my-pi/pi-tui/prompt/welcome';
import { Text } from '@oh-my-pi/pi-tui/components/text';
import { nativeImageNode } from '@oh-my-pi/pi-tui/native/blobs';
import type { DescribeContext, NativeNode } from '@oh-my-pi/pi-tui/native/node';
import { hintsRow } from '@oh-my-pi/pi-tui/native/overlay';
import type { Locale } from './contracts.js';
import { dictionary } from './i18n.js';
import wordmark from './droid-wordmark.svg';

// Factory's official CLI wordmark, bundled locally without a startup network request.
// Source: https://docs.factory.com/images/droid-ascii-wordmark.svg
const WORDMARK = nativeImageNode(Buffer.from(wordmark), 'image/svg+xml', {
  alt: 'Droid', w: 320, max: { w: 1 }, role: 'droid.welcome.wordmark',
}, 'logo');

/** Keep omp's welcome card, typography and key hints; replace only its product identity. */
export class DroidWelcome extends WelcomeComponent {
  private sessionTitle = '';
  private readonly fallback = new Text('Droid', 0, 0);
  private projected?: { original: NativeNode; node: NativeNode };

  constructor(private locale: Locale) { super(''); }

  override get tip(): string { return dictionary(this.locale).welcomeHint; }

  sync(title: string, locale: Locale): void {
    if (title === this.sessionTitle && locale === this.locale) return;
    this.sessionTitle = title;
    this.locale = locale;
    this.fallback.setText(title ? `Droid · ${title}` : 'Droid');
    this.invalidate();
  }

  override invalidate(): void {
    super.invalidate();
    this.projected = undefined;
  }

  // Bootstrap before the native handshake must never paint omp's identity or version.
  override render(width: number): readonly string[] { return this.fallback.render(width); }

  override describe(cx: DescribeContext): NativeNode {
    const original = super.describe(cx);
    if (this.projected?.original === original) return this.projected.node;
    const project = (source: NativeNode): NativeNode => {
      if (source.k === 'row' && source.p?.role === 'omp.welcome.lockup') return {
        ...source, p: { ...source.p, max: { w: 1 } }, c: [WORDMARK],
      };
      if (source.k === 'text' && source.p?.role === 'omp.welcome.tip-text' && this.sessionTitle) return {
        ...source, p: { ...source.p, text: this.sessionTitle, spans: undefined },
      };
      const children = source.c?.filter(child => !this.sessionTitle || !('k' in child) || child.p?.role !== 'omp.welcome.tip-icon')
        .map(child => 'k' in child ? project(child) : child);
      return { ...source, ...(children ? { c: children } : {}) };
    };
    const t = dictionary(this.locale);
    const shortcuts = hintsRow([
      { keys: ['/'], label: t.welcomeCommands },
      { keys: ['enter'], label: t.send },
      { keys: ['shift+enter'], label: t.welcomeNewline },
      { keys: ['ctrl+o'], label: t.welcomeDetails },
      { keys: ['escape'], label: t.welcomeStop },
    ], 'shortcuts');
    if (shortcuts.k !== 'row') throw new Error('The omp shortcut strip must be a row.');
    const welcome = project(original);
    const node: NativeNode = { ...welcome, c: [...(welcome.c ?? []), {
      ...shortcuts, p: { ...shortcuts.p, role: 'droid.welcome.shortcuts' },
    }] };
    this.projected = { original, node };
    return node;
  }
}
