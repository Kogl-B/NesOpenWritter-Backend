import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseExtraction } from './proposals.js';

test('дата несостоявшегося плана не становится датой отказа', () => {
  const text = 'Мира хотела завтра взорвать мост, но отказалась от замысла.';
  const raw = JSON.stringify({ events: [{ name: 'Мира отказалась от замысла', quote: text, dateText: 'завтра' }] });
  assert.equal(parseExtraction(raw, text)[0]?.dateText, '');
});

test('дата состоявшегося события и дословная цитата сохраняются', () => {
  const text = 'Послезавтра в 06:30 рыбаки освободили лодки, вмёрзшие в лёд.';
  const raw = JSON.stringify({ events: [{
    name: 'Лодки освободили', quote: text, dateText: 'послезавтра в 06:30', anchorText: '01.01.2032',
  }] });
  const [event] = parseExtraction(raw, text);
  assert.equal(event?.dateText, 'Послезавтра в 06:30');
  assert.equal(event?.quote, text);
  assert.equal(event?.anchorText, '');
});

test('предложение без проверяемого фрагмента не порождает событие', () => {
  const raw = JSON.stringify({ events: [{ name: 'Мира взорвала мост', quote: 'Мира взорвала мост на рассвете.' }] });
  assert.throws(() => parseExtraction(raw, 'Мост остался цел.'), /проверяемой цитатой/);
});

test('неопределённая связь со штормом сохраняется без числовой даты', () => {
  const text = 'После шторма, когда стих ветер, жители разобрали завалы на пристани.';
  const raw = JSON.stringify({ events: [{ name: 'Разбор завалов', quote: text }] });
  assert.equal(parseExtraction(raw, text)[0]?.dateText, 'После шторма');
});

test('однозначное время того же дня восстанавливается из цитаты с известной опорой', () => {
  const quote = 'Тогда, в 12:00 того же дня, Арсен запечатал первый том описи.';
  const text = 'Она вспомнила 03.05.2039. ' + quote;
  const event = { name: 'Запечатан первый том', quote, anchorText: '03.05.2039' };
  assert.equal(parseExtraction(JSON.stringify({events:[event]}), text)[0]?.dateText, 'в 12:00 того же дня');
  assert.equal(parseExtraction(JSON.stringify({events:[{...event, anchorText:''}]}), text)[0]?.dateText, '');
  const ambiguous = quote + ' В 14:00 того же дня печать проверили.';
  assert.equal(parseExtraction(JSON.stringify({events:[{...event, quote:ambiguous}]}), text+' В 14:00 того же дня печать проверили.')[0]?.dateText, '');
});

test('дата и время того же дня извлекаются из одной дословной цитаты при пропуске полей ИИ', () => {
  const quote = 'Она вспомнила 03.05.2039. Тогда, в 12:00 того же дня, Арсен запечатал первый том описи.';
  const event = { name: 'Запечатан том', quote };
  const [result] = parseExtraction(JSON.stringify({events:[event]}), quote);
  assert.equal(result?.dateText, 'в 12:00 того же дня');
  assert.equal(result?.anchorText, '03.05.2039');
  const ambiguous = 'Она вспоминала 01.05.2039 и 03.05.2039. Тогда, в 12:00 того же дня, Арсен запечатал первый том описи.';
  const [undated] = parseExtraction(JSON.stringify({events:[{...event,quote:ambiguous}]}), ambiguous);
  assert.equal(undated?.anchorText, '');
  assert.equal(undated?.dateText, '');
});
