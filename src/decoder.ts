import type { HeaderField } from './types.js';
import { QpackError } from './errors.js';
import { encodePrefixedInt, decodePrefixedInt, type DecodedInt } from './prefixed-int.js';
import { decodeStringLiteral, concatBytes, type DecodedString } from './strings.js';
import { STATIC_TABLE } from './static-table.js';

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
    private readonly maxTableCapacity: number;
    private readonly maxBlockedStreams: number;

    /** The current dynamic table capacity, as set by the peer's encoder */
    private tableCapacity = 0;
    /** The total number of dynamic table insertions ever made */
    private insertCount = 0;

    private encoderStreamBuffer = new Uint8Array(0);
    private pendingDecoderStreamData: Uint8Array[] = [];

    constructor(options: QpackDecoderOptions = {}) {
        this.maxTableCapacity = options.maxTableCapacity ?? 0;
        this.maxBlockedStreams = options.maxBlockedStreams ?? 0;
    }

    /** MaxEntries as defined in RFC 9204 s4.5.1.1 */
    private get maxEntries(): number {
        return Math.floor(this.maxTableCapacity / 32);
    }

    /**
     * Process incoming data from the peer's encoder stream. This may unblock
     * previously requested field section decodes.
     */
    processEncoderStreamData(data: Uint8Array): void {
        const buffer = this.encoderStreamBuffer.length > 0
            ? concatBytes([this.encoderStreamBuffer, data])
            : data;

        let offset = 0;
        try {
            while (offset < buffer.length) {
                const end = this.processEncoderInstruction(buffer, offset);
                if (end === null) break; // Incomplete: wait for more data
                offset = end;
            }
        } catch (error) {
            // Any parse failure on the encoder stream is an encoder stream error:
            if (error instanceof QpackError && error.code === 'QPACK_DECOMPRESSION_FAILED') {
                throw new QpackError('QPACK_ENCODER_STREAM_ERROR', error.message);
            }
            throw error;
        }

        // Retain any incomplete trailing instruction (copied, as `data` may
        // be reused by the caller):
        this.encoderStreamBuffer = buffer.slice(offset);
    }

    /**
     * Processes a single encoder stream instruction, returning the offset
     * after it, or null if it isn't yet completely received.
     */
    private processEncoderInstruction(data: Uint8Array, offset: number): number | null {
        const firstByte = data[offset]!;

        if (firstByte & 0x80) { // Insert with name reference
            throw new Error('qpack: not yet implemented (dynamic table insertion)');
        } else if (firstByte & 0x40) { // Insert with literal name
            throw new Error('qpack: not yet implemented (dynamic table insertion)');
        } else if (firstByte & 0x20) { // Set dynamic table capacity
            const capacity = decodePrefixedInt(data, offset, 5);
            if (capacity === null) return null;
            this.setTableCapacity(capacity.value);
            return capacity.end;
        } else { // Duplicate
            throw new Error('qpack: not yet implemented (duplicate)');
        }
    }

    private setTableCapacity(capacity: number): void {
        if (capacity > this.maxTableCapacity) {
            throw new QpackError(
                'QPACK_ENCODER_STREAM_ERROR',
                `Dynamic table capacity ${capacity} exceeds the maximum of ` +
                `${this.maxTableCapacity}`
            );
        }
        this.tableCapacity = capacity;
    }

    /**
     * Decode a complete encoded field section, received on the given stream.
     * The returned promise resolves once all dynamic table entries the
     * section requires have been received (immediately, unless the section
     * is blocked) and rejects with a QpackError if the section is invalid.
     */
    async decodeFieldSection(streamId: number, data: Uint8Array): Promise<HeaderField[]> {
        const requiredInsertCount = this.decodeRequiredInsertCount(data);

        if (requiredInsertCount.value > this.insertCount) {
            throw new Error('qpack: not yet implemented (blocked field sections)');
        }

        const base = this.decodeBase(data, requiredInsertCount);
        const headers = this.parseFieldLines(
            data,
            base.end,
            base.value,
            requiredInsertCount.value
        );

        if (requiredInsertCount.value > 0) {
            // Section Acknowledgment (required by RFC 9204 s4.4.1):
            this.pendingDecoderStreamData.push(encodePrefixedInt(streamId, 7, 0x80));
        }

        return headers;
    }

    /** Reconstructs the Required Insert Count (RFC 9204 s4.5.1.1) */
    private decodeRequiredInsertCount(data: Uint8Array): DecodedInt {
        const encoded = this.required(decodePrefixedInt(data, 0, 8));
        if (encoded.value === 0) return encoded;

        const fullRange = 2 * this.maxEntries;
        if (encoded.value > fullRange) {
            throw new QpackError(
                'QPACK_DECOMPRESSION_FAILED',
                'Invalid Required Insert Count'
            );
        }

        const maxValue = this.insertCount + this.maxEntries;
        const maxWrapped = Math.floor(maxValue / fullRange) * fullRange;
        let value = maxWrapped + encoded.value - 1;

        if (value > maxValue) {
            if (value <= fullRange) {
                throw new QpackError(
                    'QPACK_DECOMPRESSION_FAILED',
                    'Invalid Required Insert Count'
                );
            }
            value -= fullRange;
        }

        if (value === 0) {
            throw new QpackError(
                'QPACK_DECOMPRESSION_FAILED',
                'Invalid Required Insert Count'
            );
        }

        return { value, end: encoded.end };
    }

    /** Decodes the Base from the Sign bit and Delta Base (RFC 9204 s4.5.1.2) */
    private decodeBase(data: Uint8Array, requiredInsertCount: DecodedInt): DecodedInt {
        const sign = (data[requiredInsertCount.end]! & 0x80) !== 0;
        const deltaBase = this.required(decodePrefixedInt(data, requiredInsertCount.end, 7));

        if (!sign) {
            return {
                value: requiredInsertCount.value + deltaBase.value,
                end: deltaBase.end
            };
        }

        const base = requiredInsertCount.value - deltaBase.value - 1;
        if (base < 0) {
            throw new QpackError('QPACK_DECOMPRESSION_FAILED', 'Negative Base');
        }
        return { value: base, end: deltaBase.end };
    }

    private parseFieldLines(
        data: Uint8Array,
        offset: number,
        base: number,
        requiredInsertCount: number
    ): HeaderField[] {
        const headers: HeaderField[] = [];

        while (offset < data.length) {
            const firstByte = data[offset]!;

            if (firstByte & 0x80) {
                // Indexed field line (T flag: static vs dynamic)
                const index = this.required(decodePrefixedInt(data, offset, 6));
                headers.push((firstByte & 0x40)
                    ? this.staticEntry(index.value)
                    : this.dynamicEntry(base - index.value - 1, requiredInsertCount)
                );
                offset = index.end;
            } else if (firstByte & 0x40) {
                // Literal field line with name reference (N=0x20, T=0x10)
                const index = this.required(decodePrefixedInt(data, offset, 4));
                const name = (firstByte & 0x10)
                    ? this.staticEntry(index.value).name
                    : this.dynamicEntry(base - index.value - 1, requiredInsertCount).name;
                const value = this.required(decodeStringLiteral(data, index.end, 7));
                headers.push({ name, value: value.value });
                offset = value.end;
            } else if (firstByte & 0x20) {
                // Literal field line with literal name (N=0x10, H=0x08)
                const name = this.required(decodeStringLiteral(data, offset, 3));
                const value = this.required(decodeStringLiteral(data, name.end, 7));
                headers.push({ name: name.value, value: value.value });
                offset = value.end;
            } else if (firstByte & 0x10) {
                // Indexed field line with post-base index
                const index = this.required(decodePrefixedInt(data, offset, 4));
                headers.push(this.dynamicEntry(base + index.value, requiredInsertCount));
                offset = index.end;
            } else {
                // Literal field line with post-base name reference (N=0x08)
                const index = this.required(decodePrefixedInt(data, offset, 3));
                const name = this.dynamicEntry(base + index.value, requiredInsertCount).name;
                const value = this.required(decodeStringLiteral(data, index.end, 7));
                headers.push({ name, value: value.value });
                offset = value.end;
            }
        }

        return headers;
    }

    private staticEntry(index: number): HeaderField {
        const entry = STATIC_TABLE[index];
        if (!entry) {
            throw new QpackError(
                'QPACK_DECOMPRESSION_FAILED',
                `Invalid static table index ${index}`
            );
        }
        return entry;
    }

    private dynamicEntry(absoluteIndex: number, requiredInsertCount: number): HeaderField {
        if (absoluteIndex < 0 || absoluteIndex >= requiredInsertCount) {
            throw new QpackError(
                'QPACK_DECOMPRESSION_FAILED',
                `Dynamic table reference (${absoluteIndex}) outside this section's ` +
                `Required Insert Count (${requiredInsertCount})`
            );
        }
        throw new Error('qpack: not yet implemented (dynamic table)');
    }

    /** Rejects incomplete data: within a field section this means truncation */
    private required<T extends DecodedInt | DecodedString>(decoded: T | null): T {
        if (decoded === null) {
            throw new QpackError('QPACK_DECOMPRESSION_FAILED', 'Truncated field section');
        }
        return decoded;
    }

    /**
     * Notify the decoder that a stream has been reset, so any blocked decode
     * is abandoned and a Stream Cancellation can be emitted.
     */
    cancelStream(streamId: number): void {
        // With a zero-capacity dynamic table no state can be affected, so we
        // omit cancellations entirely (permitted by RFC 9204 s2.2.2.2):
        if (this.maxTableCapacity === 0) return;

        this.pendingDecoderStreamData.push(encodePrefixedInt(streamId, 6, 0x40));
    }

    /**
     * Drain any pending output for the decoder stream (section
     * acknowledgments, stream cancellations and insert count increments).
     * Returns an empty array if there is nothing to send.
     */
    takeDecoderStreamData(): Uint8Array {
        if (this.pendingDecoderStreamData.length === 0) return new Uint8Array(0);
        const output = concatBytes(this.pendingDecoderStreamData);
        this.pendingDecoderStreamData = [];
        return output;
    }
}
