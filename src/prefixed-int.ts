/**
 * Prefixed integer encoding, as defined in RFC 7541 section 5.1 and used
 * throughout QPACK (RFC 9204 section 4.1.1).
 */

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
    throw new Error('qpack: not yet implemented');
}

/**
 * Decodes a prefixed integer starting at the given offset. Returns null if
 * the data is incomplete (more bytes are needed).
 */
export function decodePrefixedInt(
    data: Uint8Array,
    offset: number,
    prefixBits: number
): DecodedInt | null {
    throw new Error('qpack: not yet implemented');
}
