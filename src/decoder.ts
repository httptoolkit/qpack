import type { HeaderField } from './types.js';

export interface QpackDecoderOptions {
    /**
     * Our advertised SETTINGS_QPACK_MAX_TABLE_CAPACITY: the maximum dynamic
     * table capacity the peer's encoder may set. Defaults to 0, which
     * disables all dynamic table usage.
     */
    maxTableCapacity?: number;

    /**
     * Our advertised SETTINGS_QPACK_BLOCKED_STREAMS: the maximum number of
     * field sections that may be blocked waiting for dynamic table
     * insertions at any one time. Defaults to 0.
     */
    maxBlockedStreams?: number;
}

export class QpackDecoder {
    constructor(options: QpackDecoderOptions = {}) {
        void options;
    }

    /**
     * Process incoming data from the peer's encoder stream. This may unblock
     * previously requested field section decodes.
     */
    processEncoderStreamData(data: Uint8Array): void {
        throw new Error('qpack: not yet implemented');
    }

    /**
     * Decode a complete encoded field section, received on the given stream.
     * The returned promise resolves once all dynamic table entries the
     * section requires have been received (immediately, unless the section
     * is blocked) and rejects with a QpackError if the section is invalid.
     */
    decodeFieldSection(streamId: number, data: Uint8Array): Promise<HeaderField[]> {
        throw new Error('qpack: not yet implemented');
    }

    /**
     * Notify the decoder that a stream has been reset, so any blocked decode
     * is abandoned and a Stream Cancellation can be emitted.
     */
    cancelStream(streamId: number): void {
        throw new Error('qpack: not yet implemented');
    }

    /**
     * Drain any pending output for the decoder stream (section
     * acknowledgments, stream cancellations and insert count increments).
     * Returns an empty array if there is nothing to send.
     */
    takeDecoderStreamData(): Uint8Array {
        throw new Error('qpack: not yet implemented');
    }
}
