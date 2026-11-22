/** Длина видимого текста редактора. Разметка и картинки в счёт не входят. */
export function countPlainText(doc: unknown): { words: number; chars: number } {
  let words = 0;
  let chars = 0;
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const row = node as { type?: string; text?: string; content?: unknown[] };
    if (row.type === 'text' && typeof row.text === 'string') {
      chars += row.text.length;
      const trimmed = row.text.trim();
      if (trimmed) words += trimmed.split(/\s+/).length;
    }
    if (Array.isArray(row.content)) {
      for (const child of row.content) walk(child);
    }
  };
  walk(doc);
  return { words, chars };
}
