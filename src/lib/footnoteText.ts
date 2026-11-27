interface TextNode {
  type?: string;
  text?: string;
  attrs?: { text?: string };
  marks?: Array<{ type?: string; attrs?: { text?: string } }>;
  content?: TextNode[];
}

/** Rendering notes is opt-in. Word counts and chronology keep using the manuscript text. */
export function projectFootnotes(content: unknown, notes: string[], reference = (number: number) => `[${number}]`): unknown {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return content;
  const marker = (text: string): TextNode => ({ type: 'text', text: reference(notes.push(text)) });

  function visit(node: TextNode): TextNode {
    if (node.type === 'footnoteReference') {
      const text = node.attrs?.text;
      return typeof text === 'string' && text.trim() ? marker(text) : { type: 'text', text: '' };
    }
    if (!Array.isArray(node.content)) return node;
    const children: TextNode[] = [];
    let marked: TextNode[] = [];
    let note = '';
    function flush() {
      if (!note) return;
      if (marked.length !== 1 || marked[0]?.text !== '*') children.push(...marked);
      children.push(marker(note));
      note = '';
      marked = [];
    }
    for (const child of node.content) {
      if (!child || typeof child !== 'object') continue;
      const text = child.type === 'text' ? child.marks?.find((mark) => mark.type === 'footnote')?.attrs?.text : undefined;
      if (typeof text !== 'string' || !text.trim()) {
        flush();
        children.push(visit(child));
      } else {
        if (note !== text) flush();
        note = text;
        marked.push(child);
      }
    }
    flush();
    return { ...node, content: children };
  }

  return visit(content as TextNode);
}

export function footnoteLines(notes: string[]): string[] {
  return notes.length ? ['Сноски', ...notes.map((note, i) => `${i + 1}. ${note}`)] : [];
}
