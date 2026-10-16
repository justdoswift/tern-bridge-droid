import { SkillMessageComponent } from '@oh-my-pi/pi-tui/chat/skill-message';
import type { NativeNode } from '@oh-my-pi/pi-tui/native/node';

export interface DroidSkillPresentation { name: string; path: string; args: string; content: string; lineCount: number }

// Droid's native slash resolver (Ke/fAe) emits this complete system-notification,
// not Pi's <skill name="…" location="…"> envelope. Match only the canonical
// generated structure, never generic mentions, snippets, or incomplete streaming text.
const start = '<system-notification>\n';
const end = '\n</skill>\n</system-notification>';
const introduction = 'Skills provide specialized capabilities and domain knowledge. The user has selected the following skill for immediate execution by typing /';
const instruction = " in their message; that token invokes the skill and is not a path or part of the request. Begin following the skill's instructions now.";
const header = /^<skill filePath="([^"<>\r\n]+)">\n<name>([a-z0-9-]+)<\/name>\n<description>([^\n]*)<\/description>\n/;

function decodeAttribute(value: string): string {
  return value.replace(/&(amp|quot|lt|gt|#39);/g, (_, entity: string) => ({ amp: '&', quot: '"', lt: '<', gt: '>', '#39': "'" })[entity]!);
}

/** Pure display projection; raw content is retained verbatim, including wrapper and arguments. */
export function droidSkillPresentations(source: string): DroidSkillPresentation[] | undefined {
  const first = source.indexOf(start);
  if (first < 0 || (first > 0 && source.slice(first - 2, first) !== '\n\n')) return undefined;
  const prompt = first === 0 ? '' : source.slice(0, first - 2);
  // A quoted/example wrapper is ordinary user text. Do not interpret fenced examples.
  if (prompt.includes('```') || prompt.includes('~~~')) return undefined;
  const parsed: DroidSkillPresentation[] = [];
  let offset = first;
  let trailing = '';
  while (offset < source.length) {
    if (!source.startsWith(start + introduction, offset)) return undefined;
    const introEnd = source.indexOf('\n', offset + start.length);
    if (introEnd < 0) return undefined;
    const rest = source.slice(introEnd + 1);
    const match = header.exec(rest);
    if (!match) return undefined;
    const [, path, name] = match;
    if (!/[a-z0-9]/.test(name!)) return undefined;
    if (source.slice(offset + start.length, introEnd) !== introduction + name + instruction) return undefined;
    const bodyStart = introEnd + 1 + match[0].length;
    const close = source.indexOf(end, bodyStart);
    if (close < 0 || !source.slice(bodyStart, close).trim()) return undefined;
    const next = close + end.length;
    const content = source.slice(offset, next);
    // Nested/ambiguous envelopes are left visible rather than accidentally concealing prose.
    if (source.slice(bodyStart, close).includes('<skill') || source.slice(bodyStart, close).includes('<system-notification>')) return undefined;
    parsed.push({ name: name!, path: decodeAttribute(path!), args: '', content, lineCount: source.slice(bodyStart, close).split('\n').length });
    if (next === source.length) break;
    if (!source.startsWith('\n\n', next)) return undefined;
    offset = next + 2;
    if (!source.startsWith(start, offset)) { trailing = source.slice(offset); break; }
  }
  if (!parsed.length || (prompt && trailing) || (trailing && parsed.length !== 1)) return undefined;
  if (prompt) {
    for (const skill of parsed) {
      // Native embedded invocation requires a whole skill token after whitespace.
      if (!new RegExp(`(^|\\s)/${skill.name}(?=$|[^a-zA-Z0-9_/-])`, 'i').test(prompt)) return undefined;
    }
  }
  const firstSkill = parsed[0]!;
  firstSkill.args = trailing || (prompt.toLowerCase().startsWith(`/${firstSkill.name} `)
    ? prompt.slice(firstSkill.name.length + 2) : prompt.toLowerCase() === `/${firstSkill.name}` ? '' : prompt);
  // The first expansion always recovers the entire original payload, without reconstruction.
  firstSkill.content = source;
  return parsed;
}

export class DroidSkillCard extends SkillMessageComponent {
  private projection: { original: NativeNode; node: NativeNode } | undefined;
  constructor(private readonly presentation: DroidSkillPresentation) {
    super({
      role: 'custom', customType: 'skill', content: presentation.content, display: true, timestamp: 0,
      details: { name: presentation.name, path: presentation.path, args: presentation.args, lineCount: presentation.lineCount },
    });
  }

  override describe(): NativeNode {
    const original = super.describe();
    if (original.k !== 'card' || !original.p?.collapsed || !this.presentation.args.trim()) return original;
    if (this.projection?.original === original) return this.projection.node;
    // Tern otherwise hides all children on a collapsed card. The stock component
    // omits the loaded prompt while collapsed; preview only exposes the user's args.
    const node: NativeNode = { ...original, p: { ...original.p, preview: { lines: 3 } } };
    this.projection = { original, node };
    return node;
  }
}

export function skillMessage(presentation: DroidSkillPresentation): DroidSkillCard {
  return new DroidSkillCard(presentation);
}
