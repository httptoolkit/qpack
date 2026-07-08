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

/**
 * Wraps a promise with a timeout, so async decodes that wrongly never settle
 * (e.g. blocked field sections that never unblock) fail promptly and clearly
 * instead of hitting the full mocha timeout.
 */
export function withTimeout<T>(promise: Promise<T>, ms = 1000): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`Timed out after ${ms}ms`)),
            ms
        );
        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error) => { clearTimeout(timer); reject(error); }
        );
    });
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
