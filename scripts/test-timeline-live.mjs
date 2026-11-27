import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const base = new URL(process.env.TIMELINE_TEST_URL ?? 'http://127.0.0.1:5174');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use an isolated loopback deployment');
assert.ok(process.env.TIMELINE_TEST_ACCOUNT, 'Provide a funded account JSON file from the isolated test database');
const { email, password } = JSON.parse(readFileSync(process.env.TIMELINE_TEST_ACCOUNT, 'utf8'));
assert.match(email, /^timeline-[a-z0-9-]+@example\.test$/);
const cookies = new Map();

async function request(path, { method = 'GET', body, expected = 200 } = {}) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      origin: base.origin,
      ...(body == null ? {} : { 'content-type': 'application/json' }),
      cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
    },
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';')[0];
    const separator = pair.indexOf('=');
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  const json = await response.json();
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(json)}`);
  return json;
}

const post = (path, body, expected = 201) => request(path, { method: 'POST', body, expected });
const patch = (path, body) => request(path, { method: 'PATCH', body });
const doc = (text) => ({
  type: 'doc', content: text.split('\n').map((paragraph) => ({
    type: 'paragraph', content: [{ type: 'text', text: paragraph }],
  })),
});

await post('/api/auth/sign-in/email', { email, password }, 200);
const start = '2032-01-01T22:15';
const { project } = await post('/api/projects', {
  name: 'Маршрут фонарщика',
  settings: { structure: 'chapters', timelineAnalysis: { enabled: true, start } },
});
const root = `/api/projects/${project.id}`;
const scope = `${root}/timeline-analysis`;
const { character } = await post(`${root}/characters`, { name: 'Мира' });
const { item } = await post(`${root}/items`, { name: 'Медный ключ' });
const { location } = await post(`${root}/locations`, { name: 'Северные ворота' });

const samples = [
  {
    title: 'Ключ от ворот',
    text: '01.01 в 08:10 Мира впервые открыла Северные ворота Медным ключом. За воротами её ждал обоз с лекарствами. 02.01.2032 в 14:00 обоз доставил лекарства в лазарет, и карантин сняли.',
    claims: [
      { date: '01.01.2032 08:10', evidence: /открыла Северные ворота/, links: true },
      { date: '02.01.2032 14:00', evidence: /доставил лекарства|карантин сняли/ },
    ],
  },
  {
    title: 'Развязанные лодки',
    text: 'Послезавтра в 06:30 рыбаки освободили лодки, вмёрзшие в лёд. Благодаря этому последний паром ушёл до прихода паводка.',
    claims: [{ date: '03.01.2032 06:30', evidence: /освободили лодки/ }],
  },
  {
    title: 'Погасший маяк',
    text: '31.12.2032 в 23:55 вахтенный заступил на дежурство. Через десять минут после начала дежурства погас маяк. Вахтенный зажёг сигнальный костёр, чтобы увести корабль от рифов.',
    claims: [{ date: '01.01.2033 00:05', evidence: /погас маяк/ }],
  },
  {
    title: 'Телеграмма',
    text: 'Через два часа Мира получила телеграмму о закрытии перевала. Она хотела завтра взорвать мост, но отказалась от замысла. Мост остался цел.',
    claims: [{ date: '02.01.2032 00:15', evidence: /получила телеграмму/ }],
    absent: /взорвала мост|взрыв моста/i,
  },
  {
    title: 'После шторма',
    text: 'После шторма жители разобрали завалы на пристани. Когда именно закончился шторм, в журнале не записали.',
    claims: [{ date: null, evidence: /разобрали завалы/ }],
  },
];

async function createChapter(sample, automatic = false) {
  const { chapter } = await post(`${root}/chapters`, {
    kind: 'chapter', title: sample.title, content: doc(sample.text), wordCount: sample.text.split(/\s+/).length,
  });
  if (automatic) {
    await patch(`${root}/chapters/${chapter.id}`, { stage: 'done' });
    assert.equal((await request(`${scope}?chapterId=${chapter.id}`)).job, null);
    await post(scope, { chapterId: chapter.id }, 409);
  }
  await patch(`${root}/chapters/${chapter.id}`, { stage: 'published' });
  if (!automatic) await post(scope, { chapterId: chapter.id }, 202);
  return chapter;
}

async function settled(chapter) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const { job } = await request(`${scope}?chapterId=${chapter.id}`);
    if (job?.status === 'failed') throw new Error(`${chapter.title}: ${job.error}`);
    if (job?.status === 'done' && !job.stale) return job;
    await delay(2500);
  }
  throw new Error(`No terminal analysis for ${chapter.title}`);
}

function review(job, proposal, decision, expected) {
  return post(`${scope}/${job.id}/proposals/${proposal.index}`, decision, expected ?? 200);
}

const chapters = [];
for (const [index, sample] of samples.entries()) chapters.push(await createChapter(sample, index === 0));
if (process.env.TIMELINE_TEST_STATE) {
  writeFileSync(process.env.TIMELINE_TEST_STATE, JSON.stringify({ projectId: project.id, email, password, chapters }), { mode: 0o600 });
}
const jobs = await Promise.all(chapters.map(settled));
let firstEvent;
let relativeEvent;
for (const [index, sample] of samples.entries()) {
  const job = jobs[index];
  if (sample.absent) {
    assert.ok(job.proposals.every((p) => !sample.absent.test(p.name)), sample.title);
    assert.ok(job.proposals.every((p) => !/отказал/i.test(p.name) || p.knownDate === null), 'Дата плана не стала датой отказа');
  }
  for (const claim of sample.claims) {
    const proposal = job.proposals.find((p) => claim.evidence.test(p.quote) && p.knownDate === claim.date);
    assert.ok(proposal, `${sample.title}: ожидалось ${claim.date}, ответ ${JSON.stringify(job.proposals.map(({ name, quote, dateText, anchorText, knownDate }) => ({ name, quote, dateText, anchorText, knownDate })))}`);
    const decision = { disposition: 'accepted' };
    const accepted = await review(job, proposal, decision);
    const repeated = await review(job, proposal, decision);
    assert.equal(accepted.review.eventId, repeated.review.eventId);
    const eventId = accepted.review.eventId;
    const { event } = await request(`${root}/events/${eventId}`);
    assert.equal(event.at, proposal.at);
    assert.ok(event.manuscriptSources.some((source) => source.chapter.id === chapters[index].id && source.quote === proposal.quote));
    if (claim.date === null) assert.equal(event.atNumeric, null);
    if (index === 1) relativeEvent = event;
    if (claim.links) {
      firstEvent = event;
      assert.equal(event.locationId, location.id);
      const { links: characters } = await request(`${root}/events/${eventId}/characters`);
      const { links: items } = await request(`${root}/events/${eventId}/items`);
      assert.ok(characters.some((link) => link.characterId === character.id));
      assert.ok(items.some((link) => link.itemId === item.id));
    }
    console.log(`${sample.title}: ${event.at} · ${event.name}`);
  }
}
assert.ok(firstEvent);
const same = await post(scope, { chapterId: chapters[0].id }, 202);
assert.equal(same.job.id, jobs[0].id, 'Same saved version uses the existing run');
const retelling = await createChapter({
  title: 'Запись в журнале',
  text: 'В журнал Мира внесла уже известное событие: 01.01 в 08:10 она впервые открыла Северные ворота Медным ключом. Запись повторяла рассказ обозников об открытии Северных ворот.',
});
const retold = await settled(retelling);
const repetition = retold.proposals.find((p) => p.existingEventId === firstEvent.id);
assert.ok(repetition, `Не сопоставлен пересказ с существующим событием: ${JSON.stringify(retold.proposals)}`);
const before = (await request(`${root}/events`)).events.length;
await review(retold, repetition, { disposition: 'accepted', eventId: firstEvent.id });
const { event: merged } = await request(`${root}/events/${firstEvent.id}`);
assert.equal(new Set(merged.manuscriptSources.map((source) => source.chapter.id)).size, 2);
assert.equal((await request(`${root}/events`)).events.length, before);
console.log('Пересказ связан с существующим событием. Два источника, число событий прежнее.');

const fresh = await createChapter({
  title: 'Устаревшее предложение',
  text: '03.01.2032 гонец сжёг карту переправ, после чего стража потеряла маршрут.',
});
const outdated = await settled(fresh);
await patch(root, { settings: { timelineAnalysis: { enabled: false, start } } });
assert.ok(outdated.proposals.length);
await patch(`${root}/chapters/${fresh.id}/content`, {
  content: doc('Гонец передал карту стражникам, и отряд нашёл путь.'), wordCount: 9,
});
await review(outdated, outdated.proposals[0], { disposition: 'accepted' }, 409);
assert.equal((await request(`${scope}?chapterId=${fresh.id}`)).job.stale, true);
assert.equal((await request(`${root}/events`)).events.length, before);
console.log('Устаревшее предложение отклонено сервером, число событий прежнее.');

assert.ok(relativeEvent);
await patch(root, { settings: { timelineAnalysis: { enabled: true, start: '2032-01-02T22:15' } } });
await post(scope, { chapterId: chapters[1].id }, 202);
const datedAgain = await settled(chapters[1]);
const moved = datedAgain.proposals.find((proposal) => /освободили лодки/.test(proposal.quote));
assert.equal(moved?.knownDate, '04.01.2032 06:30');
await review(datedAgain, moved, { disposition: 'accepted', eventId: relativeEvent.id, updateDate: true, at: 'после шторма' }, 400);
await review(datedAgain, moved, { disposition: 'accepted', eventId: relativeEvent.id, updateDate: true });
const { event: updated } = await request(`${root}/events/${relativeEvent.id}`);
assert.equal(updated.at, '04.01.2032 06:30');
assert.equal(new Set(updated.manuscriptSources.map((source) => source.chapter.id)).size, 1);
assert.equal((await request(`${root}/events`)).events.length, before);
console.log('Новая точка отсчёта: дата существующего события обновлена после подтверждения.');
