import type { HeaderField } from '../../src/index.js';

/** Builds a Uint8Array from a hex string, ignoring whitespace */
export function hex(input: string): Uint8Array {
    const cleaned = input.replace(/\s+/g, '');
    if (cleaned.length % 2 !== 0) throw new Error(`Odd-length hex string: ${input}`);
    const bytes = cleaned.match(/../g) ?? [];
    return Uint8Array.from(bytes.map((byte) => parseInt(byte, 16)));
}

export function utf8(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

export async function expectRejection(promise: Promise<unknown>): Promise<unknown> {
    let result: unknown;
    try {
        result = await promise;
    } catch (error) {
        return error;
    }
    throw new Error(`Expected promise to reject, but it resolved with: ${
        JSON.stringify(result)
    }`);
}

/** Map of stream ID -> headers, as sorted entries for deep comparison */
export function sortedBlockEntries(
    blocks: Map<number, HeaderField[]>
): Array<[number, HeaderField[]]> {
    return [...blocks.entries()].sort(([a], [b]) => a - b);
}
