/**
 * Huffman coding for field literals, using the code defined in RFC 7541
 * Appendix B (shared by HPACK and QPACK).
 */
import { QpackError, FieldSectionTooLargeError } from './errors.js';
import { HUFFMAN_CODES, HUFFMAN_BIT_LENGTHS } from './huffman-table.js';

const EOS_SYMBOL = 256;
/** The shortest Huffman code is 5 bits, so output <= input * 8/5 */
const MAX_EXPANSION = 8 / 5;

export function huffmanEncode(data: Uint8Array): Uint8Array {
    let totalBits = 0;
    for (const byte of data) totalBits += HUFFMAN_BIT_LENGTHS[byte]!;
    const output = new Uint8Array(Math.ceil(totalBits / 8));

    // The accumulator holds under 8 pending bits plus one code of up to 30
    // bits, so it stays well within exact integer range:
    let accumulator = 0;
    let pendingBits = 0;
    let outputIndex = 0;

    for (const byte of data) {
        accumulator = accumulator * 2 ** HUFFMAN_BIT_LENGTHS[byte]! + HUFFMAN_CODES[byte]!;
        pendingBits += HUFFMAN_BIT_LENGTHS[byte]!;

        while (pendingBits >= 8) {
            pendingBits -= 8;
            const shifted = Math.floor(accumulator / 2 ** pendingBits);
            output[outputIndex++] = shifted & 0xff;
            accumulator -= (shifted & 0xff) * 2 ** pendingBits;
        }
    }

    if (pendingBits > 0) {
        // Pad the final byte with the most significant bits of EOS (all 1s):
        const padBits = 8 - pendingBits;
        output[outputIndex++] = (accumulator << padBits) | ((1 << padBits) - 1);
    }

    return output;
}

/**
 * The Huffman decoding tree: each node is a 2-element array indexed by bit,
 * holding either a child node or a decoded symbol number.
 */
type HuffmanNode = [HuffmanNode | number | null, HuffmanNode | number | null];

const DECODE_TREE: HuffmanNode = [null, null];
for (let symbol = 0; symbol <= EOS_SYMBOL; symbol++) {
    const code = HUFFMAN_CODES[symbol]!;
    const bits = HUFFMAN_BIT_LENGTHS[symbol]!;

    let node = DECODE_TREE;
    for (let i = bits - 1; i >= 0; i--) {
        const bit = (code >>> i) & 1;
        if (i === 0) {
            node[bit] = symbol;
        } else {
            if (node[bit] === null) node[bit] = [null, null];
            node = node[bit] as HuffmanNode;
        }
    }
}

/**
 * Decodes Huffman-coded data. If maxDecodedLength is given, decoding aborts
 * with a FieldSectionTooLargeError as soon as the output would exceed it,
 * bounding the work and memory spent on over-limit input.
 */
export function huffmanDecode(
    data: Uint8Array,
    maxDecodedLength: number = Infinity
): Uint8Array {
    // Skip the per-symbol limit checks entirely when the output can't
    // possibly exceed the limit:
    const checkLimit = maxDecodedLength < data.length * MAX_EXPANSION;

    const output: number[] = [];

    let node = DECODE_TREE;
    let bitsSinceSymbol = 0;
    let paddingValid = true;

    for (const byte of data) {
        for (let i = 7; i >= 0; i--) {
            const bit = (byte >>> i) & 1;
            if (bit === 0) paddingValid = false;
            bitsSinceSymbol++;

            const next = node[bit]!;
            if (typeof next === 'number') {
                if (next === EOS_SYMBOL) {
                    throw new QpackError(
                        'QPACK_DECOMPRESSION_FAILED',
                        'EOS symbol in Huffman-encoded data'
                    );
                }
                if (checkLimit && output.length >= maxDecodedLength) {
                    throw new FieldSectionTooLargeError(
                        maxDecodedLength,
                        'Huffman-coded string exceeds the remaining field ' +
                        'section budget'
                    );
                }
                output.push(next);
                node = DECODE_TREE;
                bitsSinceSymbol = 0;
                paddingValid = true;
            } else {
                node = next;
            }
        }
    }

    if (bitsSinceSymbol > 7) {
        throw new QpackError(
            'QPACK_DECOMPRESSION_FAILED',
            'Huffman padding longer than 7 bits'
        );
    }
    if (!paddingValid) {
        throw new QpackError(
            'QPACK_DECOMPRESSION_FAILED',
            'Huffman padding does not match the EOS prefix'
        );
    }

    return Uint8Array.from(output);
}
