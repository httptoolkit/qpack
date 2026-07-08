import { expect } from 'chai';

import { huffmanEncode, huffmanDecode } from '../src/huffman.js';
import { QpackError } from '../src/index.js';
import { qit } from './harness/disabled.js';
import { hex, utf8 } from './harness/utils.js';

// Huffman-encoded strings from the worked examples in RFC 7541 appendix C:
const VECTORS: Array<[text: string, encoded: string]> = [
    ['www.example.com', 'f1e3 c2e5 f23a 6ba0 ab90 f4ff'],
    ['no-cache', 'a8eb 1064 9cbf'],
    ['custom-key', '25a8 49e9 5ba9 7d7f'],
    ['custom-value', '25a8 49e9 5bb8 e8b4 bf'],
    ['302', '6402'],
    ['private', 'aec3 771a 4b'],
    ['gzip', '9bd9 ab'],
    ['Mon, 21 Oct 2013 20:13:21 GMT', 'd07a be94 1054 d444 a820 0595 040b 8166 e082 a62d 1bff'],
    ['https://www.example.com', '9d29 ad17 1863 c78f 0b97 c8e9 ae82 ae43 d3'],
    [
        'foo=ASDJKHQKBZXOQWEOPIUAXQWEOIU; max-age=3600; version=1',
        '94e7 821d d7f2 e6c7 b335 dfdf cd5b 3960 d5af 2708 7f36 72c1 ab27 ' +
        '0fb5 291f 9587 3160 65c0 03ed 4ee5 b106 3d50 07'
    ]
];

describe('huffman coding', () => {

    for (const [text, encoded] of VECTORS) {
        qit(`encode "${text}"`, () => {
            expect(huffmanEncode(utf8(text))).to.deep.equal(hex(encoded));
        });

        qit(`decode "${text}"`, () => {
            expect(huffmanDecode(hex(encoded))).to.deep.equal(utf8(text));
        });
    }

    qit('round-trip every individual byte value', () => {
        for (let byte = 0; byte < 256; byte++) {
            const input = Uint8Array.from([byte]);
            expect(huffmanDecode(huffmanEncode(input)), `byte ${byte}`)
                .to.deep.equal(input);
        }
    });

    qit('round-trip random binary data', () => {
        // Simple deterministic PRNG (xorshift32) so failures are reproducible:
        let state = 0xdeadbeef;
        const nextByte = () => {
            state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
            state >>>= 0;
            return state & 0xff;
        };

        for (let run = 0; run < 200; run++) {
            const length = run % 50;
            const input = Uint8Array.from({ length }, nextByte);
            expect(huffmanDecode(huffmanEncode(input)), `run ${run}`)
                .to.deep.equal(input);
        }
    });

    qit('encode an empty input to an empty output', () => {
        expect(huffmanEncode(new Uint8Array(0))).to.deep.equal(new Uint8Array(0));
        expect(huffmanDecode(new Uint8Array(0))).to.deep.equal(new Uint8Array(0));
    });

    qit('decode rejects the EOS symbol in the input', () => {
        // 30 one-bits (the EOS code) followed by 2 one-bits of padding.
        // RFC 7541 s5.2: EOS in the input MUST be a decoding error.
        expect(() => huffmanDecode(hex('ff ff ff ff'))).to.throw(QpackError);
    });

    qit('decode rejects padding longer than 7 bits', () => {
        // 16 one-bits: all-ones is always a strict prefix of EOS, so this is
        // 16 bits of padding, and >7 bits MUST be a decoding error.
        expect(() => huffmanDecode(hex('ff ff'))).to.throw(QpackError);
    });

    qit('decode rejects padding that does not match the EOS prefix', () => {
        // 'a' encodes to 00011 (5 bits), leaving 3 bits of padding, which
        // here is 000 instead of the required 111.
        expect(() => huffmanDecode(hex('18'))).to.throw(QpackError);
        expect(huffmanDecode(hex('1f'))).to.deep.equal(utf8('a'));
    });

});
