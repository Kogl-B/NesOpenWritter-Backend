interface BioNode {
  type: string;
  text?: string;
  attrs?: Record<string, string | number>;
  marks?: { type: string }[];
  content?: BioNode[];
}

const children: Record<string, string[]> = {
  doc: ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote', 'horizontalRule'],
  blockquote: ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote', 'horizontalRule'],
  bulletList: ['listItem'],
  orderedList: ['listItem'],
  listItem: ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote', 'horizontalRule'],
  paragraph: ['text', 'hardBreak'],
  heading: ['text', 'hardBreak'],
};
const marks = new Set(['bold', 'italic', 'underline', 'strike', 'code', 'highlight']);
const alignment = new Set(['left', 'center', 'right', 'justify']);

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function parseProfileBioDocument(document: unknown, text: string): BioNode | null {
  let remaining = 600;
  let plain = '';
  function visit(value: unknown, allowed: string[], depth: number): BioNode | null {
    if (--remaining < 0 || depth > 12) return null;
    const node = object(value);
    const type = node?.type;
    if (!node || typeof type !== 'string' || !allowed.includes(type)) return null;
    const result: BioNode = { type };
    if (type === 'text') {
      if (typeof node.text !== 'string' || !node.text.length || plain.length + node.text.length > 2000) return null;
      result.text = node.text;
      plain += node.text;
      if (Array.isArray(node.marks)) {
        const safe = [...new Set(node.marks.map(mark => object(mark)?.type))]
          .filter((mark): mark is string => typeof mark === 'string' && marks.has(mark));
        if (safe.length) result.marks = safe.map(type => ({ type }));
      }
      return result;
    }
    const attrs = object(node.attrs);
    if (type === 'heading') result.attrs = { level: 2 };
    if ((type === 'heading' || type === 'paragraph') && typeof attrs?.textAlign === 'string' && alignment.has(attrs.textAlign)) {
      result.attrs = { ...result.attrs, textAlign: attrs.textAlign };
    }
    if (type === 'orderedList' && typeof attrs?.start === 'number' && Number.isInteger(attrs.start) && attrs.start > 0 && attrs.start < 10_000) {
      result.attrs = { start: attrs.start };
    }
    const nested = children[type];
    if (!nested) return node.content === undefined ? result : null;
    if (node.content !== undefined && !Array.isArray(node.content)) return null;
    const input = Array.isArray(node.content) ? node.content : [];
    if (input.length > remaining) return null;
    const needsChildren = type !== 'paragraph' && type !== 'heading';
    if (needsChildren && !input.length) return null;
    const content: BioNode[] = [];
    for (const child of input) {
      const parsed = visit(child, nested, depth + 1);
      if (!parsed) return null;
      content.push(parsed);
    }
    if (type === 'listItem' && content[0]?.type !== 'paragraph') return null;
    if (content.length) result.content = content;
    return result;
  }
  const parsed = visit(document, ['doc'], 0);
  const visible = (value: string) => value.replace(/\s/g, '');
  return parsed && visible(plain) === visible(text) ? parsed : null;
}

export function readProfileBio(settings: unknown) {
  const source = object(settings);
  const text = (typeof source?.about === 'string' ? source.about
    : typeof source?.bio === 'string' ? source.bio : '').trim().slice(0, 2000);
  const stored = object(source?.bioDocument);
  const document = stored?.text === text ? parseProfileBioDocument(stored?.document, text) : null;
  return { text, document };
}
