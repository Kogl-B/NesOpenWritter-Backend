import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSponsrSess, sponsrAccount, sponsrSessionFromJson, sponsrSessionJson } from './sponsrSession.js';

const SESS = 's:11f05340ab34a778c04e5f227f46764f.Jd2KT8XvX7Ud3iQBSWAF6eMN0WT3jR3jmeTtjfg59yA';

describe('sponsr session', () => {
  it('берёт SESS из заголовка cookie и из кодированного значения', () => {
    assert.equal(parseSponsrSess(`theme=light; SESS=${encodeURIComponent(SESS)}; uuid=1`), SESS);
    assert.equal(parseSponsrSess(encodeURIComponent(SESS)), SESS);
    assert.equal(parseSponsrSess(SESS), SESS);
    assert.equal(parseSponsrSess(`SESS\n${SESS.slice(0, 20)}${SESS.slice(20)}`), SESS);
  });

  it('не принимает пустую строку и не повторяет её в ошибке', () => {
    assert.throws(() => parseSponsrSess('   '), /Вставьте сессию Sponsr/);
    const junk = 'not-a-session-xyz';
    assert.throws(() => parseSponsrSess(junk), (err: Error) => !err.message.includes(junk) && /cookie SESS/.test(err.message));
  });

  it('хранит сессию и читает проекты профиля', () => {
    const stored = sponsrSessionFromJson(sponsrSessionJson({ sess: SESS, accessToken: 'aaa.bbb.ccc' }));
    assert.equal(stored.sess, SESS);
    const account = sponsrAccount({
      data: { nickname: 'Иван', projectRoles: { '8748': 'owner', '3': 'reader', '12': 'editor' } },
    });
    assert.equal(account.name, 'Иван');
    assert.deepEqual(account.projectIds, [{ id: 12, role: 'editor' }, { id: 8748, role: 'owner' }]);
  });
});
