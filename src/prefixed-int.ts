/**
 * Prefixed integer encoding, as defined in RFC 7541 section 5.1 and used
 * throughout QPACK (RFC 9204 section 4.1.1).
 */
import { QpackError } from './errors.js';

// QPACK requires handling integers up to 62 bits (RFC 9204 s4.1.1), but any
// value above 2^53 - 1 is far beyond every legal limit in practice (stream
// counts, table indexes, string lengths), so rather than decoding into
// imprecise JS numbers we treat those as invalid input. 62 bits still needs
// accepting the encoding itself up to 9 continuation bytes before we can
// tell the value is excessive.
const MAX_CONTINUATION_BYTES = 9;

export interface DecodedInt {
    value: number;
    /** The offset immediately after the encoded integer */
    end: number;
}

/**
 * Encodes an integer with the given prefix length (1-8 bits). Any bits of
 * the first byte outside the prefix are taken from firstByteFlags.
 */
export function encodePrefixedInt(
    value: number,
    prefixBits: number,
    firstByteFlags: number = 0
): Uint8Array {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Cannot encode ${value} as a prefixed integer`);
    }

    const maxPrefixValue = (1 << prefixBits) - 1;
    if (value < maxPrefixValue) {
        return Uint8Array.from([firstByteFlags | value]);
    }

    const bytes = [firstByteFlags | maxPrefixValue];
    let remainder = value - maxPrefixValue;
    while (remainder >= 128) {
        bytes.push((remainder % 128) | 0x80);
        remainder = Math.floor(remainder / 128);
    }
    bytes.push(remainder);
    return Uint8Array.from(bytes);
}

/**
 * Decodes a prefixed integer starting at the given offset. Returns null if
 * the data is incomplete (more bytes are needed), and throws a QpackError
 * for values too large to represent.
 */
export function decodePrefixedInt(
    data: Uint8Array,
    offset: number,
    prefixBits: number
): DecodedInt | null {
    if (offset >= data.length) return null;

    const maxPrefixValue = (1 << prefixBits) - 1;
    let value = data[offset]! & maxPrefixValue;
    if (value < maxPrefixValue) {
        return { value, end: offset + 1 };
    }

    let factor = 1;
    for (let i = 1; ; i++) {
        if (i > MAX_CONTINUATION_BYTES) {
            throw new QpackError(
                'QPACK_DECOMPRESSION_FAILED',
                'Prefixed integer encoding too long'
            );
        }
        if (offset + i >= data.length) return null;

        const byte = data[offset + i]!;
        value += (byte & 0x7f) * factor;
        factor *= 128;

        if ((byte & 0x80) === 0) {
            if (value > Number.MAX_SAFE_INTEGER) {
                throw new QpackError(
                    'QPACK_DECOMPRESSION_FAILED',
                    'Prefixed integer value too large'
                );
            }
            return { value, end: offset + i + 1 };
        }
    }
}
