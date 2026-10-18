import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  buildInvoicePayload,
  cryptoPaymentsEnabled,
  nowpaymentsSignatureValid,
} from './nowpayments.js';

describe('nowpayments', () => {
  it('остаётся выключенной, пока флаг не равен true', () => {
    const prev = process.env.CRYPTO_PAYMENTS_ENABLED;
    delete process.env.CRYPTO_PAYMENTS_ENABLED;
    assert.equal(cryptoPaymentsEnabled(), false);
    process.env.CRYPTO_PAYMENTS_ENABLED = 'false';
    assert.equal(cryptoPaymentsEnabled(), false);
    process.env.CRYPTO_PAYMENTS_ENABLED = 'true';
    assert.equal(cryptoPaymentsEnabled(), true);
    if (prev === undefined) delete process.env.CRYPTO_PAYMENTS_ENABLED;
    else process.env.CRYPTO_PAYMENTS_ENABLED = prev;
  });

  it('собирает счёт так же, как TISMOS: USD и адрес IPN', () => {
    assert.deepEqual(
      buildInvoicePayload({
        amountUsd: 10,
        orderId: 'pay_1',
        description: 'Баланс ИИ OpenWritter',
        ipnUrl: 'https://api.example/api/payments/nowpayments/webhook',
        successUrl: 'https://openwritter.app/account',
        cancelUrl: 'https://openwritter.app/account',
      }),
      {
        price_amount: 10,
        price_currency: 'usd',
        order_id: 'pay_1',
        order_description: 'Баланс ИИ OpenWritter',
        ipn_callback_url: 'https://api.example/api/payments/nowpayments/webhook',
        success_url: 'https://openwritter.app/account',
        cancel_url: 'https://openwritter.app/account',
      },
    );
  });

  it('принимает подпись с ключами в любом порядке и отвергает чужую', () => {
    const secret = 'ipn-secret';
    const canonical = '{"a":1,"b":"x"}';
    const signature = createHmac('sha512', secret).update(canonical).digest('hex');
    assert.equal(nowpaymentsSignatureValid({ b: 'x', a: 1 }, signature, secret), true);
    assert.equal(nowpaymentsSignatureValid({ b: 'x', a: 1 }, signature, 'other'), false);
    assert.equal(nowpaymentsSignatureValid({ b: 'x', a: 2 }, signature, secret), false);
    assert.equal(nowpaymentsSignatureValid({ b: 'x', a: 1 }, '', secret), false);
  });
});
