/** Страница Фикбука в выдаче «50 страниц, 18 838 слов». */
export const PAGE_WORDS = 377;

export interface SearchableBook {
  title: string;
  authorName: string;
  description: string;
  cycle: string;
  genres: string[];
  genreNames: string[];
  tags: string[];
  status: string;
  words: number;
  views: number;
  likes: number;
  favorites: number;
  createdAt: string;
  textUpdatedAt: string;
}

export interface CatalogQuery {
  q?: string;
  genre?: string;
  status?: string;
  author?: string;
  tag?: string;
  excludeTag?: string;
  cycle?: string;
  sort?: string;
  minWords?: string;
  maxWords?: string;
  minPages?: string;
  maxPages?: string;
  size?: string;
  updatedDays?: string;
}

const SIZE_PAGES: Record<string, { min: number; max: number }> = {
  drabble: { min: 0, max: 3 },
  mini: { min: 0, max: 20 },
  midi: { min: 21, max: 70 },
  maxi: { min: 71, max: Number.POSITIVE_INFINITY },
};

export function pageCount(words: number): number {
  if (words <= 0) return 0;
  return Math.ceil(words / PAGE_WORDS);
}

function parts(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function ids(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function pageBounds(query: CatalogQuery): { min: number; max: number } | null {
  const preset = SIZE_PAGES[query.size ?? ''];
  if (preset) return preset;
  const min = Number(query.minPages ?? '');
  const max = Number(query.maxPages ?? '');
  const hasMin = Number.isFinite(min) && min > 0;
  const hasMax = Number.isFinite(max) && max > 0;
  if (!hasMin && !hasMax) return null;
  return { min: hasMin ? min : 0, max: hasMax ? max : Number.POSITIVE_INFINITY };
}

function mentions(book: SearchableBook, part: string): boolean {
  return [...book.tags, ...book.genreNames].some((item) => item.toLowerCase().includes(part));
}

/** Выдача каталога. Жанр берётся с потомками, метки требуются все, исключённая метка выкидывает книгу. */
export function filterCatalogBooks<T extends SearchableBook>(
  books: T[],
  query: CatalogQuery,
  expandGenre: (id: string) => string[],
  now = Date.now(),
): T[] {
  const q = (query.q ?? '').trim().toLowerCase();
  const author = (query.author ?? '').trim().toLowerCase();
  const cycle = (query.cycle ?? '').trim().toLowerCase();
  const tags = parts(query.tag);
  const excluded = parts(query.excludeTag);
  const statuses = ids(query.status);
  const genreIds = ids(query.genre);
  const allowed = genreIds.length
    ? new Set(genreIds.flatMap((id) => expandGenre(id)))
    : null;
  const pages = pageBounds(query);
  const minWords = pages ? 0 : Number(query.minWords ?? 0) || 0;
  const maxWords = pages ? 0 : Number(query.maxWords ?? 0) || 0;
  const updatedDays = Number(query.updatedDays ?? 0) || 0;
  const freshAfter = updatedDays > 0 ? now - updatedDays * 86400000 : 0;

  const found = books.filter((book) => {
    if (allowed && !book.genres.some((id) => allowed.has(id))) return false;
    if (statuses.length > 0 && !statuses.includes(book.status)) return false;
    if (author && !book.authorName.toLowerCase().includes(author)) return false;
    if (cycle && !book.cycle.toLowerCase().includes(cycle)) return false;
    if (tags.some((part) => !mentions(book, part))) return false;
    if (excluded.some((part) => mentions(book, part))) return false;
    if (minWords && book.words < minWords) return false;
    if (maxWords && book.words > maxWords) return false;
    if (pages) {
      const count = pageCount(book.words);
      if (count < pages.min || count > pages.max) return false;
    }
    if (freshAfter && Date.parse(book.textUpdatedAt) < freshAfter) return false;
    if (!q) return true;
    const hay = [book.title, book.authorName, book.description, book.cycle, ...book.tags, ...book.genreNames].join(' ').toLowerCase();
    return hay.includes(q);
  });

  const sort = query.sort ?? 'popular';
  found.sort((a, b) => {
    if (sort === 'new') return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (sort === 'updated') return Date.parse(b.textUpdatedAt) - Date.parse(a.textUpdatedAt);
    if (sort === 'likes') return b.likes - a.likes || b.views - a.views;
    if (sort === 'words') return b.words - a.words;
    if (sort === 'favorites') return b.favorites - a.favorites || b.likes - a.likes;
    return b.views - a.views || b.likes - a.likes || b.words - a.words;
  });
  return found;
}
