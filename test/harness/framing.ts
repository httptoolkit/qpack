/**
 * The QPACK offline interop file format
 * (https://github.com/quicwg/base-drafts/wiki/QPACK-Offline-Interop):
 * a sequence of blocks, each a 64-bit big-endian stream ID, a 32-bit
 * big-endian length, then that many bytes of QPACK data. Stream ID 0 is
 * the encoder stream; other IDs are field sections for those streams.
 */

export const ENCODER_STREAM_ID = 0;

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
