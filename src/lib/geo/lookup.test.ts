import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { countryOfIp } from './lookup.js';

describe('geo lookup', () => {
  it('узнаёт страну публичного адреса и молчит на пустом', () => {
    assert.equal(countryOfIp('8.8.8.8'), 'US');
    assert.equal(countryOfIp('77.88.8.8'), 'RU');
    assert.equal(countryOfIp(null), null);
    assert.equal(countryOfIp(''), null);
  });
});
