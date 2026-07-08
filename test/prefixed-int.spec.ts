import { expect } from 'chai';

import { encodePrefixedInt, decodePrefixedInt } from '../src/prefixed-int.js';
import { QpackError } from '../src/index.js';

import { hex } from './harness/utils.js';

describe('prefixed integers', () => {

    // Examples from RFC 7541 appendix C.1:

    it('encode 10 in a 5-bit prefix', () => {
        expect(encodePrefixedInt(10, 5)).to.deep.equal(hex('0a'));
    });

    it('encode 1337 in a 5-bit prefix', () => {
        expect(encodePrefixedInt(1337, 5)).to.deep.equal(hex('1f 9a 0a'));
    });

    it('encode 42 in an 8-bit prefix', () => {
        expect(encodePrefixedInt(42, 8)).to.deep.equal(hex('2a'));
    });

    it('encode with flag bits outside the prefix', () => {
        expect(encodePrefixedInt(10, 5, 0b1100_0000)).to.deep.equal(hex('ca'));
        expect(encodePrefixedInt(1337, 5, 0b0010_0000)).to.deep.equal(hex('3f 9a 0a'));
    });

    it('decode 10 from a 5-bit prefix', () => {
        expect(decodePrefixedInt(hex('0a'), 0, 5)).to.deep.equal({ value: 10, end: 1 });
    });

    it('decode 1337 from a 5-bit prefix', () => {
        expect(decodePrefixedInt(hex('1f 9a 0a'), 0, 5)).to.deep.equal({ value: 1337, end: 3 });
    });

    it('decode 42 from an 8-bit prefix', () => {
        expect(decodePrefixedInt(hex('2a'), 0, 8)).to.deep.equal({ value: 42, end: 1 });
    });

    it('decode ignores flag bits outside the prefix', () => {
        expect(decodePrefixedInt(hex('ca'), 0, 5)).to.deep.equal({ value: 10, end: 1 });
    });

    it('decode from a non-zero offset', () => {
        expect(decodePrefixedInt(hex('ff ff 1f 9a 0a ff'), 2, 5))
            .to.deep.equal({ value: 1337, end: 5 });
    });

    it('decode returns null for incomplete data', () => {
        expect(decodePrefixedInt(new Uint8Array(0), 0, 5)).to.equal(null);
        expect(decodePrefixedInt(hex('1f'), 0, 5)).to.equal(null);
        expect(decodePrefixedInt(hex('1f 9a'), 0, 5)).to.equal(null);
        expect(decodePrefixedInt(hex('1f ff ff'), 0, 5)).to.equal(null);
    });

    it('round-trip values of all sizes across all prefix lengths', () => {
        const values = [
            0, 1, 5, 30, 31, 32, 62, 63, 64, 126, 127, 128, 254, 255, 256,
            16383, 16384, 65535, 2 ** 24, 2 ** 30, 2 ** 40, 2 ** 52
        ];
        for (let prefixBits = 1; prefixBits <= 8; prefixBits++) {
            for (const value of values) {
                const encoded = encodePrefixedInt(value, prefixBits);
                const decoded = decodePrefixedInt(encoded, 0, prefixBits);
                expect(decoded, `value ${value}, prefix ${prefixBits}`)
                    .to.deep.equal({ value, end: encoded.length });
            }
        }
    });

    it('decode rejects values above 2^53 - 1', () => {
        // QPACK requires handling integers up to 62 bits (RFC 9204 s4.1.1),
        // but any value above Number.MAX_SAFE_INTEGER is always far beyond
        // every legal limit in practice, so we reject them as invalid input
        // rather than decoding into imprecise numbers.
        // 2^62 - 1 with an 8-bit prefix: ff then (2^62 - 1 - 255) in 7-bit groups
        let remaining = 2n ** 62n - 1n - 255n;
        const bytes = [0xff];
        while (remaining >= 128n) {
            bytes.push(Number(remaining % 128n) | 0x80);
            remaining /= 128n;
        }
        bytes.push(Number(remaining));

        expect(() => decodePrefixedInt(new Uint8Array(bytes), 0, 8))
            .to.throw(QpackError);
    });

});
