import { chapterBlocks, excerpt } from './text.js';

export const KIT_PLATFORMS = ['boosty', 'patreon', 'author_today', 'litnet', 'wattpad', 'ficbook', 'rulate'] as const;
export type KitPlatform = (typeof KIT_PLATFORMS)[number];

const ROOT: Record<KitPlatform, string> = {
  boosty: 'boosty.to',
  patreon: 'patreon.com',
  author_today: 'author.today',
  litnet: 'litnet.com',
  wattpad: 'wattpad.com',
  ficbook: 'ficbook.net',
  rulate: 'rulate.ru',
};

const HOME: Record<KitPlatform, string> = {
  boosty: 'https://boosty.to/',
  patreon: 'https://www.patreon.com/posts/new',
  author_today: 'https://author.today/',
  litnet: 'https://litnet.com/',
  wattpad: 'https://www.wattpad.com/myworks',
  ficbook: 'https://ficbook.net/',
  rulate: 'https://tl.rulate.ru/',
};

export function isKitPlatform(value: string): value is KitPlatform {
  return (KIT_PLATFORMS as readonly string[]).includes(value);
}

export function kitOpenUrl(platform: KitPlatform, bookUrl: string): string {
  const saved = bookUrl.trim();
  if (!saved) return HOME[platform];
  return assertKitUrl(platform, saved);
}

/** Адрес книги или уже вышедшей главы на этой площадке. */
export function assertKitUrl(platform: KitPlatform, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('Адрес должен начинаться с https://');
  }
  if (url.protocol !== 'https:') throw new Error('Адрес должен начинаться с https://');
  const host = url.hostname.toLowerCase();
  const root = ROOT[platform];
  if (host !== root && !host.endsWith(`.${root}`)) {
    throw new Error(`Адрес должен быть на ${root}`);
  }
  return url.toString();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

type Mark = { type?: string };
type Node = { type?: string; text?: string; marks?: Mark[]; content?: Node[] };

function wrap(text: string, marks: Mark[] | undefined): string {
  let html = escapeHtml(text);
  for (const mark of marks ?? []) {
    if (mark.type === 'bold') html = `<strong>${html}</strong>`;
    else if (mark.type === 'italic') html = `<em>${html}</em>`;
    else if (mark.type === 'underline') html = `<u>${html}</u>`;
  }
  return html;
}

function inlineHtml(nodes: Node[] | undefined): string {
  return (nodes ?? []).map((node) => {
    if (node.type === 'text' && typeof node.text === 'string') return wrap(node.text, node.marks);
    if (node.type === 'hardBreak') return '<br>';
    if (Array.isArray(node.content)) return inlineHtml(node.content);
    return '';
  }).join('');
}

function blockHtml(node: Node): string {
  const inner = inlineHtml(node.content).trim();
  if (!inner) return '';
  if (node.type === 'blockquote') return `<blockquote><p>${inner}</p></blockquote>`;
  if (node.type === 'heading') return `<p><strong>${inner}</strong></p>`;
  return `<p>${inner}</p>`;
}

/** Простой HTML для вставки в редактор площадки. Чужие теги из текста экранируются. */
export function chapterHtml(doc: unknown): string {
  const root = doc && typeof doc === 'object' ? doc as Node : {};
  const nodes = root.type === 'doc' || !root.type ? (root.content ?? []) : [root];
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.type === 'bulletList' || node.type === 'orderedList' || node.type === 'listItem' || node.type === 'doc') {
      for (const child of node.content ?? []) walk(child);
      return;
    }
    const html = blockHtml(node);
    if (html) parts.push(html);
  };
  for (const node of nodes) walk(node);
  return parts.join('\n');
}

function notes(platform: KitPlatform, words: number): string[] {
  if (platform === 'boosty' || platform === 'patreon') {
    return [
      'Вставьте заголовок и текст в новый пост.',
      'Кому открыт пост — всем, подписчикам или за разовую оплату — выбирается на площадке.',
      'Тизер ниже можно поставить как превью для тех, кому пост закрыт.',
    ];
  }
  if (platform === 'author_today' || platform === 'litnet') {
    return [
      'Заголовок вставьте в название главы, текст — в тело.',
      'Платная глава или бесплатная отмечается уже на площадке.',
    ];
  }
  if (platform === 'wattpad') {
    const length = words < 1500 || words > 4000
      ? `В главе ${words} слов. На Wattpad удобная длина части около 2500 слов.`
      : `В главе ${words} слов.`;
    return [
      length,
      'Редактор Wattpad оставляет жирный, курсив и подчёркивание. Свой шрифт он не принимает.',
      'Описание, язык и рейтинг относятся ко всей истории и заполняются на Wattpad один раз.',
    ];
  }
  if (platform === 'ficbook') {
    return [
      'Текст вставляется в главу. Шапка произведения заполняется один раз: фандом, рейтинг, направленность, пейринг, предупреждения.',
    ];
  }
  return [
    'Рулейт публикует переводы и авторские книги. Главу вставляют в уже созданную книгу.',
    'Цена главы, подписка и дата выхода отмечаются на Рулейте.',
    'В тексте остаются абзацы, жирный, курсив, подчёркивание и цитата.',
  ];
}

export interface KitPackage {
  platform: KitPlatform;
  title: string;
  bodyPlain: string;
  bodyHtml: string;
  teaser: string;
  notes: string[];
  openUrl: string;
  words: number;
}

export function kitPackage(input: {
  platform: KitPlatform;
  title: string;
  doc: unknown;
  bookUrl?: string;
}): KitPackage {
  const bodyPlain = chapterBlocks(input.doc).join('\n\n');
  const words = bodyPlain.trim() ? bodyPlain.trim().split(/\s+/).length : 0;
  const teaser = input.platform === 'boosty' || input.platform === 'patreon'
    ? excerpt(bodyPlain, 500)
    : '';
  return {
    platform: input.platform,
    title: input.title.trim() || 'Глава',
    bodyPlain,
    bodyHtml: chapterHtml(input.doc) || '<p></p>',
    teaser,
    notes: notes(input.platform, words),
    openUrl: kitOpenUrl(input.platform, input.bookUrl ?? ''),
    words,
  };
}
