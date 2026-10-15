import { describe, expect, test } from 'bun:test';

import { ReferenceRetryPolicy } from '../../../../src/application/wagering/reference-retry-policy';

describe('ReferenceRetryPolicy', () => {
  const policy = new ReferenceRetryPolicy();
  const createdAt = new Date('2026-10-15T00:00:00Z');

  test('uses exponential delays capped at five minutes', () => {
    for (const [attempts, delay] of [
      [0, 1_000],
      [1, 2_000],
      [2, 4_000],
      [8, 256_000],
      [9, 300_000],
      [20, 300_000],
    ] as const) {
      expect(
        policy.nextAttemptAt(createdAt, attempts, createdAt).getTime() - createdAt.getTime(),
      ).toBe(delay);
    }
  });

  test('never schedules beyond the TTL', () => {
    const beforeExpiry = new Date(createdAt.getTime() + 86_400_000 - 100);
    expect(policy.nextAttemptAt(createdAt, 10, beforeExpiry).getTime()).toBe(
      createdAt.getTime() + 86_400_000,
    );
  });

  test('expires at either the attempt limit or TTL boundary', () => {
    expect(policy.isExpired(createdAt, 19, createdAt)).toBe(false);
    expect(policy.isExpired(createdAt, 20, createdAt)).toBe(true);
    expect(policy.isExpired(createdAt, 0, new Date(createdAt.getTime() + 86_400_000))).toBe(true);
  });
});
