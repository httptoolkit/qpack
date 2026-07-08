import type { HeaderField } from './types.js';
import { QpackError } from './errors.js';
import { encodePrefixedInt, decodePrefixedInt } from './prefixed-int.js';
import { encodeStringLiteral, concatBytes } from './strings.js';
import { STATIC_EXACT_MATCHES, STATIC_NAME_MATCHES } from './static-table.js';

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

const NO_BYTES = new Uint8Array(0);

export class QpackEncoder {
    private readonly maxTableCapacity: number;
    private readonly maxBlockedStreams: number;
    private readonly dynamicTableCapacity: number;
    private readonly useHuffman: boolean;

    /** The total number of dynamic table insertions ever made */
    private insertCount = 0;
    /** How many of our insertions the peer has confirmed receiving */
    private knownReceivedCount = 0;
    /**
     * The Required Insert Counts of sent-but-unacknowledged field sections
     * that referenced the dynamic table, per stream, oldest first.
     */
    private readonly unackedSections = new Map<number, number[]>();

    private decoderStreamBuffer = new Uint8Array(0);

    constructor(options: QpackEncoderOptions = {}) {
        this.maxTableCapacity = options.maxTableCapacity ?? 0;
        this.maxBlockedStreams = options.maxBlockedStreams ?? 0;
        this.dynamicTableCapacity = options.dynamicTableCapacity ?? this.maxTableCapacity;
        this.useHuffman = options.useHuffman ?? true;

        if (this.dynamicTableCapacity > this.maxTableCapacity) {
            throw new Error(
                `Dynamic table capacity (${this.dynamicTableCapacity}) cannot exceed ` +
                `the peer's maximum (${this.maxTableCapacity})`
            );
        }
    }

    encodeFieldSection(streamId: number, headers: HeaderField[]): EncodedFieldSection {
        void streamId; // Referenced once sections can await acknowledgment

        const parts: Uint8Array[] = [
            // Field section prefix: with no dynamic table references, the
            // Required Insert Count and Base are both encoded as 0:
            Uint8Array.from([0, 0])
        ];

        for (const { name, value } of headers) {
            const exactIndex = STATIC_EXACT_MATCHES.get(`${name}\0${value}`);
            if (exactIndex !== undefined) {
                // Indexed field line, static table:
                parts.push(encodePrefixedInt(exactIndex, 6, 0xc0));
                continue;
            }

            const nameIndex = STATIC_NAME_MATCHES.get(name);
            if (nameIndex !== undefined) {
                // Literal field line with static name reference:
                parts.push(encodePrefixedInt(nameIndex, 4, 0x50));
            } else {
                // Literal field line with literal name:
                parts.push(encodeStringLiteral(name, 3, 0x20, this.useHuffman));
            }
            parts.push(encodeStringLiteral(value, 7, 0, this.useHuffman));
        }

        return {
            fieldSection: concatBytes(parts),
            encoderStreamData: NO_BYTES
        };
    }

    /**
     * Process incoming data from the peer's decoder stream (section
     * acknowledgments, stream cancellations and insert count increments).
     */
    processDecoderStreamData(data: Uint8Array): void {
        const buffer = this.decoderStreamBuffer.length > 0
            ? concatBytes([this.decoderStreamBuffer, data])
            : data;

        let offset = 0;
        try {
            while (offset < buffer.length) {
                const end = this.processDecoderInstruction(buffer, offset);
                if (end === null) break; // Incomplete: wait for more data
                offset = end;
            }
        } catch (error) {
            if (error instanceof QpackError && error.code === 'QPACK_DECOMPRESSION_FAILED') {
                throw new QpackError('QPACK_DECODER_STREAM_ERROR', error.message);
            }
            throw error;
        }

        this.decoderStreamBuffer = buffer.slice(offset);
    }

    private processDecoderInstruction(data: Uint8Array, offset: number): number | null {
        const firstByte = data[offset]!;

        if (firstByte & 0x80) { // Section acknowledgment
            const streamId = decodePrefixedInt(data, offset, 7);
            if (streamId === null) return null;
            this.acknowledgeSection(streamId.value);
            return streamId.end;
        } else if (firstByte & 0x40) { // Stream cancellation
            const streamId = decodePrefixedInt(data, offset, 6);
            if (streamId === null) return null;
            this.unackedSections.delete(streamId.value);
            return streamId.end;
        } else { // Insert count increment
            const increment = decodePrefixedInt(data, offset, 6);
            if (increment === null) return null;
            this.increaseKnownReceivedCount(increment.value);
            return increment.end;
        }
    }

    private acknowledgeSection(streamId: number): void {
        const sections = this.unackedSections.get(streamId);
        if (!sections || sections.length === 0) {
            throw new QpackError(
                'QPACK_DECODER_STREAM_ERROR',
                `Section acknowledgment for stream ${streamId}, which has no ` +
                `unacknowledged sections`
            );
        }

        const requiredInsertCount = sections.shift()!;
        if (sections.length === 0) this.unackedSections.delete(streamId);

        // Acknowledging a section implicitly acknowledges every insertion up
        // to its Required Insert Count:
        this.knownReceivedCount = Math.max(this.knownReceivedCount, requiredInsertCount);
    }

    private increaseKnownReceivedCount(increment: number): void {
        if (increment === 0 || this.knownReceivedCount + increment > this.insertCount) {
            throw new QpackError(
                'QPACK_DECODER_STREAM_ERROR',
                `Invalid insert count increment (${increment}, with ` +
                `${this.knownReceivedCount} of ${this.insertCount} insertions acknowledged)`
            );
        }
        this.knownReceivedCount += increment;
    }
}
