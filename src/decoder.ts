import type { HeaderField } from './types.js';
import { QpackError } from './errors.js';
import { encodePrefixedInt, decodePrefixedInt, type DecodedInt } from './prefixed-int.js';
import { decodeStringLiteral, concatBytes, type DecodedString } from './strings.js';
import { STATIC_TABLE } from './static-table.js';
import { DynamicTable, entrySize } from './dynamic-table.js';

export interface QpackDecoderOptions {
    /**
     * Our advertised SETTINGS_QPACK_MAX_TABLE_CAPACITY: the maximum dynamic
     * table capacity the peer's encoder may set. Defaults to 0, which
     * disables all dynamic table usage.
     */
    maxTableCapacity?: number;

    /**
     * Our advertised SETTINGS_QPACK_BLOCKED_STREAMS: the maximum number of
     * streams whose field sections may be blocked waiting for dynamic table
     * insertions at any one time. Defaults to 0.
     */
    maxBlockedStreams?: number;
}

interface BlockedSection {
    streamId: number;
    data: Uint8Array;
    requiredInsertCount: DecodedInt;
    resolve: (headers: HeaderField[]) => void;
    reject: (error: Error) => void;
}

export class QpackDecoder {
    private readonly maxTableCapacity: number;
    private readonly maxBlockedStreams: number;

    private readonly table = new DynamicTable();
    private blockedSections: BlockedSection[] = [];

    /**
     * Our best lower bound on the peer's Known Received Count, from the
     * Insert Count Increments and Section Acknowledgments we've emitted.
     * Used to size increments so the peer's count never overruns.
     */
    private peerKnownInsertCount = 0;

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

        if (this.table.insertCount > this.peerKnownInsertCount) {
            // Insert Count Increment. Emitting this eagerly for every batch
            // of insertions is a policy choice (RFC 9204 s4.4.3 leaves the
            // timing open): it keeps the encoder's view current even when
            // nothing referencing the entries is decoded.
            this.pendingDecoderStreamData.push(encodePrefixedInt(
                this.table.insertCount - this.peerKnownInsertCount, 6, 0x00
            ));
            this.peerKnownInsertCount = this.table.insertCount;

            this.unblockReadySections();
        }
    }

    /**
     * Processes a single encoder stream instruction, returning the offset
     * after it, or null if it isn't yet completely received.
     */
    private processEncoderInstruction(data: Uint8Array, offset: number): number | null {
        const firstByte = data[offset]!;

        if (firstByte & 0x80) { // Insert with name reference (T=0x40: static)
            const nameIndex = decodePrefixedInt(data, offset, 6);
            if (nameIndex === null) return null;
            const value = decodeStringLiteral(data, nameIndex.end, 7);
            if (value === null) return null;

            const name = (firstByte & 0x40)
                ? this.staticEntry(nameIndex.value).name
                : this.insertedEntry(nameIndex.value).name;
            this.insertEntry({ name, value: value.value });
            return value.end;
        } else if (firstByte & 0x40) { // Insert with literal name (H=0x20)
            const name = decodeStringLiteral(data, offset, 5);
            if (name === null) return null;
            const value = decodeStringLiteral(data, name.end, 7);
            if (value === null) return null;

            this.insertEntry({ name: name.value, value: value.value });
            return value.end;
        } else if (firstByte & 0x20) { // Set dynamic table capacity
            const capacity = decodePrefixedInt(data, offset, 5);
            if (capacity === null) return null;
            this.setTableCapacity(capacity.value);
            return capacity.end;
        } else { // Duplicate
            const index = decodePrefixedInt(data, offset, 5);
            if (index === null) return null;
            this.insertEntry(this.insertedEntry(index.value));
            return index.end;
        }
    }

    /** Looks up an insert instruction's reference, relative to the insert count */
    private insertedEntry(relativeIndex: number): HeaderField {
        const absoluteIndex = this.table.insertCount - relativeIndex - 1;
        const entry = this.table.get(absoluteIndex);
        if (!entry) {
            throw new QpackError(
                'QPACK_ENCODER_STREAM_ERROR',
                `Insertion references a missing dynamic table entry ` +
                `(absolute index ${absoluteIndex})`
            );
        }
        return entry;
    }

    private insertEntry(field: HeaderField): void {
        if (!this.table.canFit(entrySize(field))) {
            throw new QpackError(
                'QPACK_ENCODER_STREAM_ERROR',
                `Cannot insert an entry of size ${entrySize(field)} into a dynamic ` +
                `table with capacity ${this.table.capacity}`
            );
        }
        this.table.insert(field);
    }

    private setTableCapacity(capacity: number): void {
        if (capacity > this.maxTableCapacity) {
            throw new QpackError(
                'QPACK_ENCODER_STREAM_ERROR',
                `Dynamic table capacity ${capacity} exceeds the maximum of ` +
                `${this.maxTableCapacity}`
            );
        }
        this.table.setCapacity(capacity);
    }

    /**
     * Decode a complete encoded field section, received on the given stream.
     * The returned promise resolves once all dynamic table entries the
     * section requires have been received (immediately, unless the section
     * is blocked) and rejects with a QpackError if the section is invalid.
     */
    async decodeFieldSection(streamId: number, data: Uint8Array): Promise<HeaderField[]> {
        const requiredInsertCount = this.decodeRequiredInsertCount(data);

        if (requiredInsertCount.value <= this.table.insertCount) {
            return this.decodeSectionNow(streamId, data, requiredInsertCount);
        }

        // Blocked: wait for the required insertions to arrive.
        const blockedStreams = new Set(this.blockedSections.map((s) => s.streamId));
        blockedStreams.add(streamId);
        if (blockedStreams.size > this.maxBlockedStreams) {
            throw new QpackError(
                'QPACK_DECOMPRESSION_FAILED',
                `Too many blocked streams (limit ${this.maxBlockedStreams})`
            );
        }

        return new Promise<HeaderField[]>((resolve, reject) => {
            this.blockedSections.push({
                streamId,
                data: data.slice(), // Copied, as the caller may reuse the buffer
                requiredInsertCount,
                resolve,
                reject
            });
        });
    }

    private unblockReadySections(): void {
        const stillBlocked: BlockedSection[] = [];
        for (const section of this.blockedSections) {
            if (section.requiredInsertCount.value > this.table.insertCount) {
                stillBlocked.push(section);
                continue;
            }
            try {
                section.resolve(this.decodeSectionNow(
                    section.streamId,
                    section.data,
                    section.requiredInsertCount
                ));
            } catch (error) {
                section.reject(error as Error);
            }
        }
        this.blockedSections = stillBlocked;
    }

    private decodeSectionNow(
        streamId: number,
        data: Uint8Array,
        requiredInsertCount: DecodedInt
    ): HeaderField[] {
        const base = this.decodeBase(data, requiredInsertCount);
        const headers = this.parseFieldLines(
            data,
            base.end,
            base.value,
            requiredInsertCount.value
        );

        if (requiredInsertCount.value > 0) {
            // Section Acknowledgment (required by RFC 9204 s4.4.1). This also
            // tells the peer about every insertion up to this section's
            // Required Insert Count:
            this.pendingDecoderStreamData.push(encodePrefixedInt(streamId, 7, 0x80));
            this.peerKnownInsertCount = Math.max(
                this.peerKnownInsertCount,
                requiredInsertCount.value
            );
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

        const maxValue = this.table.insertCount + this.maxEntries;
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
        const entry = this.table.get(absoluteIndex);
        if (!entry) {
            throw new QpackError(
                'QPACK_DECOMPRESSION_FAILED',
                `Dynamic table reference to an evicted entry (absolute index ` +
                `${absoluteIndex})`
            );
        }
        return entry;
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
        const cancelled = this.blockedSections.filter((s) => s.streamId === streamId);
        this.blockedSections = this.blockedSections.filter((s) => s.streamId !== streamId);
        for (const section of cancelled) {
            section.reject(new Error(`Stream ${streamId} cancelled while blocked`));
        }

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
