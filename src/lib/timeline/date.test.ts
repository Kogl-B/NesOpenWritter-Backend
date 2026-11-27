import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveTimelineDate, timelineSettingsSchema } from './date.js';

test('точные даты и даты без года сохраняют время', () => {
  const start = '2032-01-01T22:15';
  assert.equal(resolveTimelineDate('01.01 в 08:10', start).at, '01.01.2032 08:10');
  assert.equal(resolveTimelineDate('02.01.2032 в 14:00', '').at, '02.01.2032 14:00');
  assert.equal(resolveTimelineDate('2032-01-02T10:20', '').at, '02.01.2032 10:20');
  assert.equal(resolveTimelineDate('29 февраля 2032', '').at, '29.02.2032');
});

test('относительные дни используют начало повествования или опору в сцене', () => {
  const start = '2032-01-01T22:15';
  assert.equal(resolveTimelineDate('послезавтра в 06:30', start).at, '03.01.2032 06:30');
  assert.equal(resolveTimelineDate('послезавтра', start, '28.02.2032').at, '01.03.2032');
  assert.equal(resolveTimelineDate('вчера', start).at, '31.12.2031');
  assert.equal(resolveTimelineDate('через неделю', start).at, '08.01.2032');
});

test('относительное время пересекает полночь и границу года', () => {
  const start = '2032-01-01T22:15';
  assert.equal(resolveTimelineDate('через два часа', start).at, '02.01.2032 00:15');
  assert.equal(resolveTimelineDate('через десять минут после начала дежурства', start, '31.12.2032 в 23:55').at, '01.01.2033 00:05');
  assert.equal(resolveTimelineDate('через 10 минут', '2032-01-31T23:55').at, '01.02.2032 00:05');
});

test('без достаточной опоры координата остаётся пустой', () => {
  for (const [value, base, anchor] of [
    ['послезавтра', '', ''],
    ['01.01', '', ''],
    ['через два часа', '2032-01-01', ''],
    ['после шторма', '2032-01-01', ''],
    ['послезавтра', '2032-01-01', 'день осады'],
    ['29.02.2031', '', ''],
    ['31.02', '2032-01-01', ''],
    ['01.01 в 24:10', '2032-01-01', ''],
  ]) {
    assert.deepEqual(resolveTimelineDate(value!, base!, anchor), { at: value, atNumeric: null, date: null });
  }
});

test('ось сортирует события с временем, включая високосный год', () => {
  const labels = ['01.01.2032', '29.02.2032 01:30', '29.02.2032 23:59', '31.12.2032 23:59', '01.01.2033'];
  const axis = labels.map((label) => resolveTimelineDate(label, '').atNumeric!);
  assert.equal(axis[0], 2032 * 365);
  assert.equal(axis.at(-1), 2033 * 365);
  assert.ok(axis.every((value, i) => i === 0 || value > axis[i - 1]!));
});

test('настройки книги принимают дату и необязательное время', () => {
  assert.equal(timelineSettingsSchema.safeParse({ start: '2032-02-29' }).success, true);
  assert.equal(timelineSettingsSchema.safeParse({ start: '2032-02-29T23:59' }).success, true);
  assert.equal(timelineSettingsSchema.safeParse({ start: '2031-02-29' }).success, false);
  assert.equal(timelineSettingsSchema.safeParse({ start: '2032-02-29T24:00' }).success, false);
});

test('пользовательский календарь книги учитывает длину месяца и года', () => {
  const calendar = { monthsPerYear: 5, daysPerMonth: 45, settings: { monthNames: ['искр', 'листьев'] } };
  assert.equal(resolveTimelineDate('послезавтра', '0012-05-44', '', calendar).at, '01.01.0013');
  assert.equal(resolveTimelineDate('42 листьев в 09:05', '0012-05-44', '', calendar).at, '42.02.0012 09:05');
  assert.equal(resolveTimelineDate('46.02.0012', '', '', calendar).atNumeric, null);
  assert.equal(timelineSettingsSchema.safeParse({ start: '0012-05-44', calendarId: 'custom' }).success, true);
});

test('время того же дня относится к дате из сцены', () => {
  const start = '2040-03-01T23:40';
  assert.equal(resolveTimelineDate('08:10 того же дня', start, '05.03').at, '05.03.2040 08:10');
  assert.equal(resolveTimelineDate('в 08:10 в тот же день', start, '05.03').at, '05.03.2040 08:10');
  assert.equal(resolveTimelineDate('08:10 того же дня', start).atNumeric, null);
});

test('первый день истории служит опорой для послезавтра', () => {
  const start = '2040-03-01T23:40';
  assert.equal(resolveTimelineDate('послезавтра в 06:30', start, 'в первый день этой истории').at, '03.03.2040 06:30');
  assert.equal(resolveTimelineDate('послезавтра в 06:30', start, 'первый день повествования').at, '03.03.2040 06:30');
});

test('срок от названного события требует даты этого события', () => {
  const start = '2040-03-01T23:40';
  const phrase = 'через неделю после аварии на Северном шлюзе';
  assert.equal(resolveTimelineDate(phrase, start).atNumeric, null);
  assert.equal(resolveTimelineDate(phrase, start, '05.03.2040 08:10').at, '12.03.2040');
  assert.equal(resolveTimelineDate('через неделю', start).at, '08.03.2040');
});

test('дата известного события восстанавливает опору, когда ИИ вернул только его название', () => {
  const start = '2040-03-01T23:40';
  const phrase = 'через неделю после аварии на Северном шлюзе';
  assert.equal(resolveTimelineDate(phrase, start, 'аварии на Северном шлюзе', undefined, '05.03.2040 08:10').at, '12.03.2040');
  assert.equal(resolveTimelineDate(phrase, start, 'аварии на Северном шлюзе', undefined, 'без даты').atNumeric, null);
});

test('явное начало истории использует заданные календарь, дату и время', () => {
  const calendar = { monthsPerYear: 5, daysPerMonth: 45, settings: {} };
  const start = '0012-05-44T23:40';
  assert.equal(resolveTimelineDate('послезавтра в 07:05', start, 'начало истории', calendar).at, '01.01.0013 07:05');
  assert.equal(resolveTimelineDate('через два часа', start, 'в начале повествования', calendar).at, '45.05.0012 01:40');
});

test('собирательные числительные и «спустя» разрешают длительность в сутках', () => {
  const start = '2044-03-01T06:30';
  const reference = '05.03.2044 18:45';
  assert.equal(resolveTimelineDate('через двое суток после отправки', start, '', undefined, reference).at, '07.03.2044');
  assert.equal(resolveTimelineDate('спустя трое суток после отправки', start, '', undefined, reference).at, '08.03.2044');
  assert.equal(resolveTimelineDate('спустя трое суток после отправки', start).atNumeric, null);
});

test('относительная опора внутри сцены рассчитывается от указанного события', () => {
  const start = '2042-04-01T18:00';
  const phrase = 'на следующий день после переправы';
  assert.equal(resolveTimelineDate('в 07:10', start, phrase, undefined, '22.04.2042 09:00').at, '23.04.2042 07:10');
  assert.equal(resolveTimelineDate('в 07:10', start, phrase, undefined, 'без даты').atNumeric, null);
});

test('удаление опорного события оставляет относительную дату без координаты', () => {
  const start = '2042-04-01T18:00';
  const anchorPhrase = 'на следующий день после переправы';
  assert.equal(resolveTimelineDate('в 07:10', start, anchorPhrase, undefined, null).atNumeric, null);
  assert.equal(resolveTimelineDate('в 07:10', start, '22.04.2042', undefined, null).at, '22.04.2042 07:10');
});
