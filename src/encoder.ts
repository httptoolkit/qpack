import type { HeaderField } from './types.js';

export interface QpackEncoderOptions {
    /**
     * The peer's advertised SETTINGS_QPACK_MAX_TABLE_CAPACITY. Defaults to 0,
     * which disables all dynamic table usage.
     */
    maxTableCapacity?: number;

    /**
     * The peer's advertised SETTINGS_QPACK_BLOCKED_STREAMS. Defaults to 0,
     * which means no encoded field section may risk blocking on unacknowledged
     * dynamic table insertions.
     */
    maxBlockedStreams?: number;

    /**
     * The dynamic table capacity this encoder should actually use, which must
     * be no larger than maxTableCapacity. Defaults to maxTableCapacity.
     */
    dynamicTableCapacity?: number;

    /**
     * Whether to Huffman-encode field literals when doing so is smaller.
     * Defaults to true.
     */
    useHuffman?: boolean;
}

export interface EncodedFieldSection {
    /** The encoded field section, to send on the request/push stream */
    fieldSection: Uint8Array;

    /**
     * Any instructions to send on the encoder stream. These bytes must be
     * written to the encoder stream before the field section is sent.
     */
    encoderStreamData: Uint8Array;
}

export class QpackEncoder {
    constructor(options: QpackEncoderOptions = {}) {
        void options;
    }

    encodeFieldSection(streamId: number, headers: HeaderField[]): EncodedFieldSection {
        throw new Error('qpack: not yet implemented');
    }

    /**
     * Process incoming data from the peer's decoder stream (section
     * acknowledgments, stream cancellations and insert count increments).
     */
    processDecoderStreamData(data: Uint8Array): void {
        throw new Error('qpack: not yet implemented');
    }
}
