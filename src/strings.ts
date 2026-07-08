/**
 * String literals (RFC 7541 section 5.2 / RFC 9204 section 4.1.2): a
 * Huffman flag bit immediately above a length prefix, then that many bytes,
 * Huffman-coded if flagged.
 */
import { huffmanEncode, huffmanDecode } from './huffman.js';
import { encodePrefixedInt, decodePrefixedInt } from './prefixed-int.js';

/**
 * Field names & values are byte sequences on the wire. We map them to JS
 * strings as latin1 (character code == byte value), matching Node's own
 * handling of HTTP header data.
 */
export function stringToBytes(value: string): Uint8Array {
    const bytes = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code > 0xff) {
            throw new Error(
                `Cannot encode non-latin1 character (0x${code.toString(16)}) in field data`
            );
        }
        bytes[i] = code;
    }
    return bytes;
}

export function bytesToString(bytes: Uint8Array): string {
    let result = '';
    for (let i = 0; i < bytes.length; i++) {
        result += String.fromCharCode(bytes[i]!);
    }
    return result;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
    const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

export function encodeStringLiteral(
    value: string,
    prefixBits: number,
    firstByteFlags: number,
    useHuffman: boolean
): Uint8Array {
    const raw = stringToBytes(value);
    const huffmanFlag = 1 << prefixBits;

    if (useHuffman) {
        const encoded = huffmanEncode(raw);
        if (encoded.length < raw.length) {
            return concatBytes([
                encodePrefixedInt(encoded.length, prefixBits, firstByteFlags | huffmanFlag),
                encoded
            ]);
        }
    }

    return concatBytes([
        encodePrefixedInt(raw.length, prefixBits, firstByteFlags),
        raw
    ]);
}

export interface DecodedString {
    value: string;
    /** The offset immediately after the string literal */
    end: number;
}

/**
 * Decodes a string literal starting at the given offset. Returns null if
 * the data is incomplete (more bytes are needed).
 */
export function decodeStringLiteral(
    data: Uint8Array,
    offset: number,
    prefixBits: number
): DecodedString | null {
    if (offset >= data.length) return null;
    const isHuffman = (data[offset]! & (1 << prefixBits)) !== 0;

    const length = decodePrefixedInt(data, offset, prefixBits);
    if (length === null) return null;
    if (length.end + length.value > data.length) return null;

    const bytes = data.subarray(length.end, length.end + length.value);
    return {
        value: bytesToString(isHuffman ? huffmanDecode(bytes) : bytes),
        end: length.end + length.value
    };
}
