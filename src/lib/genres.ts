/** Жанры книг из каталога закрытой библиотеки (художественные и читательская нехудожка). */

export interface Genre {
  id: string;
  name: string;
  children?: Genre[];
}

export const GENRES: Genre[] = [
  {
    id: 'speculative',
    name: 'Спекулятивная фантастика',
    children: [
      {
        id: 'sf',
        name: 'Научная фантастика',
        children: [
          { id: 'hard-sf', name: 'Твёрдая НФ' },
          { id: 'soft-sf', name: 'Мягкая НФ' },
          { id: 'space-opera', name: 'Космическая опера' },
          { id: 'space-voyage', name: 'Космическое путешествие' },
          { id: 'planetary', name: 'Планетарная фантастика' },
          { id: 'military-sf', name: 'Военная НФ' },
          { id: 'cyberpunk', name: 'Киберпанк' },
          { id: 'postcyberpunk', name: 'Посткиберпанк' },
          { id: 'biopunk', name: 'Биопанк' },
          { id: 'nanopunk', name: 'Нанопанк' },
          { id: 'solarpunk', name: 'Солнечпанк' },
          { id: 'social-sf', name: 'Социальная фантастика' },
          { id: 'postapoc', name: 'Апокалипсис / Постапокалипсис' },
          { id: 'time-travel', name: 'Хронофантастика' },
          { id: 'first-contact', name: 'Первый контакт' },
          { id: 'dystopia', name: 'Утопия / Антиутопия' },
          { id: 'near-future', name: 'Ближнее будущее' },
        ],
      },
      {
        id: 'fantasy',
        name: 'Фэнтези',
        children: [
          { id: 'epic-fantasy', name: 'Высокое / эпическое фэнтези' },
          { id: 'heroic-fantasy', name: 'Героическое фэнтези' },
          { id: 'dark-fantasy', name: 'Тёмное фэнтези' },
          { id: 'urban-fantasy', name: 'Городское фэнтези' },
          { id: 'historical-fantasy', name: 'Историческое фэнтези' },
          { id: 'slavic-fantasy', name: 'Славянское фэнтези' },
          { id: 'norse-fantasy', name: 'Скандинавское фэнтези' },
          { id: 'eastern-fantasy', name: 'Восточное фэнтези' },
          { id: 'mythic-fantasy', name: 'Мифологическое фэнтези' },
          { id: 'romantic-fantasy', name: 'Романтическое фэнтези' },
          { id: 'comic-fantasy', name: 'Комедийное фэнтези' },
          { id: 'low-fantasy', name: 'Низкое фэнтези' },
          { id: 'magical-realism', name: 'Магический реализм' },
          { id: 'gaslamp', name: 'Газлайт-фэнтези' },
          { id: 'fairy-retelling', name: 'Волшебная сказка' },
          { id: 'mystic-fantasy', name: 'Мистическое фэнтези' },
        ],
      },
      {
        id: 'horror',
        name: 'Хоррор',
        children: [
          { id: 'gothic', name: 'Готический хоррор' },
          { id: 'cosmic-horror', name: 'Космический хоррор' },
          { id: 'psych-horror', name: 'Психологический хоррор' },
          { id: 'supernatural', name: 'Сверхъестественный хоррор' },
          { id: 'slasher', name: 'Слэшер' },
          { id: 'mystic', name: 'Мистика' },
          { id: 'dark-fairy', name: 'Тёмная сказка' },
          { id: 'weird', name: 'Weird Fiction' },
        ],
      },
      {
        id: 'althist',
        name: 'Альтернативная история',
        children: [
          { id: 'classic-ah', name: 'Классическая альтернативная история' },
          { id: 'cryptohistory', name: 'Криптоистория' },
          { id: 'isekai', name: 'Попаданцы / исекай' },
        ],
      },
      {
        id: 'punk',
        name: 'Смешанные жанры',
        children: [
          { id: 'steampunk', name: 'Стимпанк' },
          { id: 'dieselpunk', name: 'Дизельпанк' },
          { id: 'clockpunk', name: 'Клокпанк' },
          { id: 'atompunk', name: 'Атомпанк' },
          { id: 'dying-earth', name: 'Dying Earth' },
          { id: 'new-weird', name: 'New Weird' },
        ],
      },
      {
        id: 'progression',
        name: 'Прогрессия / геймлит',
        children: [
          { id: 'litrpg', name: 'ЛитРПГ' },
          { id: 'gamelit', name: 'GameLit' },
          { id: 'progression-fantasy', name: 'Progression Fantasy' },
          { id: 'cultivation', name: 'Cultivation / сянься' },
          { id: 'dungeon-core', name: 'Dungeon Core' },
        ],
      },
    ],
  },
  {
    id: 'mystery',
    name: 'Детектив и триллер',
    children: [
      {
        id: 'detective',
        name: 'Детектив',
        children: [
          { id: 'cozy', name: 'Классический / уютный' },
          { id: 'police', name: 'Полицейский процедурал' },
          { id: 'noir', name: 'Нуар' },
          { id: 'hardboiled', name: 'Хардбойлд' },
          { id: 'ironic-mystery', name: 'Иронический детектив' },
          { id: 'historical-mystery', name: 'Исторический детектив' },
          { id: 'legal-mystery', name: 'Юридический детектив' },
        ],
      },
      {
        id: 'thriller',
        name: 'Триллер',
        children: [
          { id: 'psych-thriller', name: 'Психологический триллер' },
          { id: 'spy', name: 'Шпионский триллер' },
          { id: 'political-thriller', name: 'Политический триллер' },
          { id: 'techno-thriller', name: 'Технотриллер' },
          { id: 'legal-thriller', name: 'Юридический триллер' },
          { id: 'medical-thriller', name: 'Медицинский триллер' },
          { id: 'action-thriller', name: 'Экшн-триллер' },
        ],
      },
      {
        id: 'crime',
        name: 'Криминал',
        children: [
          { id: 'crime-drama', name: 'Криминальная драма' },
          { id: 'gangster', name: 'Гангстерское' },
          { id: 'true-crime-fic', name: 'Художественный true crime' },
        ],
      },
    ],
  },
  {
    id: 'romance',
    name: 'Романтика',
    children: [
      { id: 'contemporary-romance', name: 'Современная романтика' },
      { id: 'new-adult', name: 'New Adult' },
      { id: 'romcom', name: 'Романтическая комедия' },
      { id: 'historical-romance', name: 'Историческая романтика' },
      { id: 'paranormal-romance', name: 'Паранормальная романтика' },
      { id: 'fantasy-romance', name: 'Фэнтези-романтика' },
      { id: 'dark-romance', name: 'Dark Romance' },
      { id: 'erotica', name: 'Эротика' },
    ],
  },
  {
    id: 'general',
    name: 'Общая проза',
    children: [
      { id: 'literary', name: 'Литературная проза' },
      { id: 'classic-lit', name: 'Классическая литература' },
      { id: 'experimental', name: 'Экспериментальная проза' },
      { id: 'historical-novel', name: 'Исторический роман' },
      { id: 'war-prose', name: 'Военная проза' },
      { id: 'family-saga', name: 'Сага / семейная хроника' },
      { id: 'realism', name: 'Реализм' },
      { id: 'social-drama', name: 'Социальная драма' },
      { id: 'political-prose', name: 'Политическая проза' },
      { id: 'russian-classic', name: 'Русская классика' },
    ],
  },
  {
    id: 'action',
    name: 'Боевик и приключения',
    children: [
      { id: 'adventure', name: 'Классические приключения' },
      { id: 'sea', name: 'Морские приключения' },
      { id: 'survival', name: 'Выживание' },
      { id: 'military-action', name: 'Военный боевик' },
      { id: 'crime-action', name: 'Криминальный боевик' },
      { id: 'western', name: 'Вестерн' },
    ],
  },
  {
    id: 'humor',
    name: 'Юмор и сатира',
    children: [
      { id: 'comedy', name: 'Комедия' },
      { id: 'parody', name: 'Пародия' },
      { id: 'absurd', name: 'Абсурд' },
      { id: 'satire', name: 'Сатира' },
      { id: 'dark-humor', name: 'Чёрный юмор' },
    ],
  },
  {
    id: 'verse',
    name: 'Поэзия и драма',
    children: [
      { id: 'lyric', name: 'Лирика' },
      { id: 'epic-poetry', name: 'Эпическая поэзия' },
      { id: 'modern-poetry', name: 'Современная поэзия' },
      { id: 'tragedy', name: 'Трагедия' },
      { id: 'drama', name: 'Драма' },
      { id: 'screenplay', name: 'Киносценарий' },
    ],
  },
  {
    id: 'children',
    name: 'Детская литература',
    children: [
      { id: 'picture', name: 'Книжки-картинки' },
      { id: 'kids-prose', name: 'Детская проза' },
      { id: 'fairy-tale', name: 'Сказки' },
      { id: 'ya-fantasy', name: 'Подростковое фэнтези' },
      { id: 'ya-sf', name: 'Подростковая фантастика' },
      { id: 'ya-romance', name: 'Подростковая романтика' },
    ],
  },
  {
    id: 'comics',
    name: 'Комиксы и графические романы',
    children: [
      { id: 'graphic-novel', name: 'Графический роман' },
      { id: 'comics-serial', name: 'Комикс' },
      { id: 'manga', name: 'Манга' },
    ],
  },
  {
    id: 'nonfiction',
    name: 'Нехудожественная литература',
    children: [
      { id: 'autobiography', name: 'Автобиография' },
      { id: 'biography', name: 'Биография' },
      { id: 'memoir', name: 'Мемуары' },
      { id: 'essays', name: 'Эссе' },
      { id: 'journalism', name: 'Журналистика' },
      { id: 'pop-science', name: 'Научпоп' },
      { id: 'history-pop', name: 'Популярная история' },
      { id: 'self-help', name: 'Саморазвитие' },
      { id: 'business', name: 'Бизнес' },
      { id: 'travel', name: 'Путешествия' },
      { id: 'true-crime', name: 'True crime' },
      { id: 'documentary', name: 'Документальная литература' },
    ],
  },
];

export function flattenGenres(nodes: Genre[] = GENRES, group = ''): Array<{ id: string; name: string; group: string }> {
  const out: Array<{ id: string; name: string; group: string }> = [];
  for (const node of nodes) {
    const nextGroup = group || node.name;
    if (!node.children?.length) out.push({ id: node.id, name: node.name, group: nextGroup });
    else {
      out.push({ id: node.id, name: node.name, group: nextGroup });
      out.push(...flattenGenres(node.children, node.name));
    }
  }
  return out;
}

const BY_ID = new Map(flattenGenres().map((g) => [g.id, g]));

export function genreName(id: string): string {
  return BY_ID.get(id)?.name ?? id;
}

export function expandGenre(id: string): string[] {
  const found = findNode(GENRES, id);
  if (!found) return [id];
  const ids: string[] = [];
  const walk = (node: Genre) => {
    ids.push(node.id);
    node.children?.forEach(walk);
  };
  walk(found);
  return ids;
}

function findNode(nodes: Genre[], id: string): Genre | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const nested = node.children ? findNode(node.children, id) : null;
    if (nested) return nested;
  }
  return null;
}
