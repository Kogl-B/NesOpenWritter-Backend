function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const row = node as { type?: string; text?: string; content?: unknown[] };
  if (row.type === 'text' && typeof row.text === 'string') return row.text;
  if (row.type === 'hardBreak') return '\n';
  if (!Array.isArray(row.content)) return '';
  return row.content.map(inlineText).join('');
}

/** Абзацы TipTap. Пустые блоки не попадают в текст площадки. */
export function chapterBlocks(doc: unknown): string[] {
  if (!doc || typeof doc !== 'object') return [];
  const content = (doc as { content?: unknown }).content;
  const nodes = Array.isArray(content) ? content : [doc];
  return nodes
    .map((node) => inlineText(node).replace(/\u00a0/g, ' ').trim())
    .filter(Boolean);
}

export function excerpt(text: string, limit = 500): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/** Анонс для соцсетей. Длинный кусок текста урезается, ссылка остаётся. */
export function announcement(input: {
  book: string;
  chapter: string;
  text: string;
  url: string;
  limit?: number;
}): string {
  const limit = input.limit ?? 2000;
  const head = `«${input.book.trim() || 'Книга'}» — ${input.chapter.trim() || 'Глава'}`;
  const url = input.url.trim();
  const gap = '\n\n';
  const tail = url ? gap + url : '';
  const room = Math.max(0, limit - head.length - tail.length - gap.length);
  const body = excerpt(input.text, room);
  return [head, body, url].filter(Boolean).join(gap).slice(0, limit);
}

export function chapterPath(projectId: string, chapterId: string): string {
  return `/read/${projectId}?c=${chapterId}`;
}

export function absoluteUrl(origin: string, path: string): string {
  return `${origin.replace(/\/$/, '')}${path}`;
}

function paragraph(text: string): string {
  return `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
}

/** HTML Sponsr: ссылка на сайт и абзацы, не длиннее лимита площадки. */
export function sponsrText(blocks: string[], url: string, limit = 150_000): string {
  const link = `<p><a href="${escapeHtml(url)}">Читать на сайте</a></p>`;
  const parts = [link];
  let size = link.length;
  for (const block of blocks) {
    const html = paragraph(block);
    if (size + 1 + html.length > limit) break;
    parts.push(html);
    size += 1 + html.length;
  }
  if (parts.length === 1) parts.push('<p></p>');
  return parts.join('\n');
}

export function sponsrTitle(title: string, book: string): string {
  const raw = title.trim() || book.trim() || 'Глава';
  const padded = raw.length >= 4 ? raw : `${raw} — глава`;
  return padded.slice(0, 256);
}
