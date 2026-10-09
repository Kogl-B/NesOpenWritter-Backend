/**
 * Сидер производительности: наполняет тестовый проект реалистичным объёмом
 * данных для измерения list-endpoint'ов и поиска.
 * Запуск: node_modules/.bin/tsx scripts/seed-perf.ts <projectId> [--clean]
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const MARK = 'PERFSEED';
const rnd = (n: number) => Math.floor(Math.random() * n);

function tipTapDoc(words: number): object {
  const paras = Math.max(1, Math.floor(words / 60));
  const content = [];
  for (let i = 0; i < paras; i++) {
    content.push({
      type: 'paragraph',
      content: [{ type: 'text', text: `Абзац ${i} длинного художественного текста с подробным описанием мира, героев и событий, чтобы данные занимали реалистичный объём в JSONB колонке и честно влияли на размер ответов и скорость запросов.` }],
    });
  }
  return { type: 'doc', content };
}

const loremBio = (i: number) => `Персонаж №${i}. ` + 'Биография с историей жизни, характером, целями и конфликтами. '.repeat(30);

async function main() {
  const clean = process.argv.includes('--clean');
  const projectId = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!projectId) throw new Error('projectId обязателен');

  if (clean) {
    const names = [
      prisma.chapter.deleteMany({ where: { projectId, metadata: { path: ['seed'], equals: MARK } } }),
      prisma.character.deleteMany({ where: { projectId, name: { startsWith: MARK } } }),
      prisma.timelineEvent.deleteMany({ where: { projectId, name: { startsWith: MARK } } }),
      prisma.location.deleteMany({ where: { projectId, name: { startsWith: MARK } } }),
      prisma.item.deleteMany({ where: { projectId, name: { startsWith: MARK } } }),
      prisma.wikiPage.deleteMany({ where: { projectId, slug: { startsWith: 'perfseed' } } }),
      prisma.worldSnapshot.deleteMany({ where: { projectId, name: { startsWith: MARK } } }),
      prisma.tag.deleteMany({ where: { projectId, name: { startsWith: MARK } } }),
      prisma.mapElement.deleteMany({ where: { projectId, name: { startsWith: MARK } } }),
      prisma.mapDrawing.deleteMany({ where: { projectId, name: { startsWith: MARK } } }),
    ];
    const r = await prisma.$transaction(names);
    console.log('cleaned:', r.map((x) => x.count).join(','));
    return;
  }

  const t0 = Date.now();

  // Главы: 120 глав × 3 сцены, контент 500-900 слов
  const chapters: { id: string }[] = [];
  for (let c = 0; c < 120; c++) {
    const ch = await prisma.chapter.create({
      data: {
        projectId, kind: 'chapter', title: `${MARK} Глава ${c + 1}`, orderIndex: c,
        summary: 'Краткое содержание главы для теста производительности списков.',
        wordCount: 900, content: tipTapDoc(300) as object, metadata: { seed: MARK },
      },
      select: { id: true },
    });
    chapters.push(ch);
    for (let s = 0; s < 3; s++) {
      await prisma.chapter.create({
        data: {
          projectId, parentId: ch.id, kind: 'scene', title: `${MARK} Сцена ${c + 1}.${s + 1}`,
          orderIndex: s, wordCount: 500 + rnd(400),
          content: tipTapDoc(500 + rnd(400)) as object, metadata: { seed: MARK },
        },
      });
    }
  }
  console.log('chapters+scenes:', 120 * 4, Date.now() - t0, 'ms');

  const charIds: string[] = [];
  for (let i = 0; i < 150; i++) {
    const c = await prisma.character.create({
      data: {
        projectId, name: `${MARK} Герой ${i}`, summary: `Краткая сводка героя ${i}.`,
        faction: i % 2 ? 'Орден' : 'Гильдия', status: 'active', dateOfBirth: '1024 год',
        biography: loremBio(i), traits: ['храбрый', 'упрямый', 'любопытный'],
        abilities: ['фехтование'], metadata: { seed: MARK },
      },
      select: { id: true },
    });
    charIds.push(c.id);
  }
  console.log('characters: 150', Date.now() - t0, 'ms');

  for (let i = 0; i < 100; i++) {
    await prisma.timelineEvent.create({
      data: {
        projectId, name: `${MARK} Событие ${i}`,
        summary: 'Кратко о событии.',
        description: 'Описание события с участниками и последствиями. '.repeat(20),
        at: new Date(1100 + i, i % 12, (i % 27) + 1).toISOString(),
        atNumeric: i * 37, importance: i % 4 === 0 ? 3 : 1,
        metadata: { seed: MARK },
      },
    });
  }
  console.log('events: 100', Date.now() - t0, 'ms');

  for (let i = 0; i < 60; i++) {
    await prisma.location.create({
      data: { projectId, name: `${MARK} Локация ${i}`, description: 'Описание места. '.repeat(25), kind: 'city', metadata: { seed: MARK } },
    });
  }
  for (let i = 0; i < 80; i++) {
    await prisma.item.create({
      data: { projectId, name: `${MARK} Предмет ${i}`, summary: 'Кратко.', description: 'Описание предмета. '.repeat(15), metadata: { seed: MARK } },
    });
  }
  console.log('locations+items: 140', Date.now() - t0, 'ms');

  for (let i = 0; i < 30; i++) {
    await prisma.wikiPage.create({
      data: {
        projectId, slug: `perfseed-page-${i}`, title: `${MARK} Статья ${i}`,
        content: 'Крупная энциклопедическая статья. '.repeat(80), category: 'Лор',
      },
    });
  }
  for (let i = 0; i < 20; i++) {
    await prisma.worldSnapshot.create({
      data: { projectId, name: `${MARK} Снимок ${i}`, description: 'Состояние мира.', state: { politics: '...', geography: '...', seed: MARK } },
    });
  }
  const tags: { id: string }[] = [];
  for (let i = 0; i < 40; i++) {
    tags.push(await prisma.tag.create({ data: { projectId, name: `${MARK}-тег-${i}`, color: '#aabbcc' }, select: { id: true } }));
  }
  for (let i = 0; i < 60; i++) {
    await prisma.entityTag.create({ data: { tagId: tags[i % 40].id, entityType: 'character', entityId: charIds[i % 150] } }).catch(() => {});
  }
  for (let i = 0; i < 50; i++) {
    await prisma.mapElement.create({
      data: {
        projectId, kind: 'marker', name: `${MARK} Город ${i}`,
        geometry: { x: rnd(2000), y: rnd(2000) }, style: { color: '#fff' }, metadata: { seed: MARK },
      },
    });
  }
  for (let i = 0; i < 80; i++) {
    await prisma.mapDrawing.create({
      data: {
        projectId, name: `${MARK} Штрих ${i}`, layer: 'default',
        payload: { tool: 'brush', points: Array.from({ length: 40 }, () => ({ x: rnd(2000), y: rnd(2000) })) },
      },
    });
  }
  console.log('wiki/snapshots/tags/map: done', Date.now() - t0, 'ms');
  console.log('SEED COMPLETE in', Date.now() - t0, 'ms');
}

main().finally(() => prisma.$disconnect());
