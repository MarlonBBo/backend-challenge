import { describe, expect, test } from 'bun:test';

import {
  canonicalJson,
  sha256CanonicalJson,
} from '../../../../src/application/shared/canonical-json';

describe('canonical JSON', () => {
  test('sorts object keys recursively while preserving array order', () => {
    expect(canonicalJson({ z: 1, nested: { b: 2, a: 1 }, array: [{ y: 2, x: 1 }] })).toBe(
      '{"array":[{"x":1,"y":2}],"nested":{"a":1,"b":2},"z":1}',
    );
  });

  test('produces the same SHA-256 hash regardless of object key order', () => {
    expect(sha256CanonicalJson({ amount: '10.00', currency: 'BRL' })).toBe(
      sha256CanonicalJson({ currency: 'BRL', amount: '10.00' }),
    );
  });
});
