/**
 * The QPACK offline interop file format
 * (https://github.com/quicwg/base-drafts/wiki/QPACK-Offline-Interop):
 * a sequence of blocks, each a 64-bit big-endian stream ID, a 32-bit
 * big-endian length, then that many bytes of QPACK data. Stream ID 0 is
 * the encoder stream; other IDs are field sections for those streams.
 */

export const ENCODER_STREAM_ID = 0;

/**
 * In the offline interop format the dynamic table capacity is agreed
 * out-of-band (the encoder's table size parameter, from the filename), and
 * encoders may use the table without sending any Set Dynamic Table Capacity
 * instruction, unlike in real HTTP/3 where the capacity starts at 0 (RFC
 * 9204 s3.2.3). ls-qpack's interop-decode initializes its table accordingly,
 * and so must we: this builds the equivalent explicit instruction to feed to
 * the decoder before any interop-format data. (Files that do contain their
 * own capacity instructions just adjust downwards from this, harmlessly.)
 */
export function impliedCapacityInstruction(tableSize: number): Uint8Array {
    // Set Dynamic Table Capacity: '001' then the capacity in a 5-bit prefix
    if (tableSize < 31) return Uint8Array.from([0x20 | tableSize]);

    const bytes = [0x3f];
    let remainder = tableSize - 31;
    while (remainder >= 128) {
        bytes.push((remainder % 128) | 0x80);
        remainder = Math.floor(remainder / 128);
    }
    bytes.push(remainder);
    return Uint8Array.from(bytes);
}

export interface InteropBlock {
    streamId: number;
    data: Uint8Array;
}

export function readInteropBlocks(buffer: Uint8Array): InteropBlock[] {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const blocks: InteropBlock[] = [];
    let offset = 0;

    while (offset < buffer.length) {
        if (offset + 12 > buffer.length) {
            throw new Error(`Truncated interop block header at offset ${offset}`);
        }
        const streamId = view.getBigUint64(offset);
        const length = view.getUint32(offset + 8);
        offset += 12;

        if (streamId > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error(`Interop block stream ID too large: ${streamId}`);
        }
        if (offset + length > buffer.length) {
            throw new Error(`Truncated interop block data at offset ${offset}`);
        }

        blocks.push({
            streamId: Number(streamId),
            data: buffer.subarray(offset, offset + length)
        });
        offset += length;
    }

    return blocks;
}

export function writeInteropBlocks(blocks: InteropBlock[]): Uint8Array {
    const totalLength = blocks.reduce((sum, block) => sum + 12 + block.data.length, 0);
    const buffer = new Uint8Array(totalLength);
    const view = new DataView(buffer.buffer);
    let offset = 0;

    for (const block of blocks) {
        view.setBigUint64(offset, BigInt(block.streamId));
        view.setUint32(offset + 8, block.data.length);
        buffer.set(block.data, offset + 12);
        offset += 12 + block.data.length;
    }

    return buffer;
}
