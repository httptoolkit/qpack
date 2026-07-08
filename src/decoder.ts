import type { HeaderField } from './types.js';
import { QpackError, FieldSectionTooLargeError } from './errors.js';
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

    /**
     * Our advertised SETTINGS_MAX_FIELD_SECTION_SIZE: the largest field
     * section (as the uncompressed sum of name + value + 32 per field) we
     * are willing to decode. Larger sections fail with
     * FieldSectionTooLargeError - a stream-level problem for the caller to
     * handle (e.g. resetting the stream or responding with 431), not a
     * connection error. Defaults to unlimited, per RFC 9114.
     */
    maxFieldSectionSize?: number;

    /**
     * Receives decoder stream data (section acknowledgments, stream
     * cancellations, insert count increments) as it is produced, including
     * acknowledgments generated when a blocked section unblocks. When not
     * set, this data must instead be drained via takeDecoderStreamData()
     * after every processEncoderStreamData, decodeFieldSection and
     * cancelStream call.
     */
    onDecoderStreamData?: (data: Uint8Array) => void;
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
    private readonly maxFieldSectionSize: number;
    private readonly onDecoderStreamData?: (data: Uint8Array) => void;

    private readonly table = new DynamicTable();
    private blockedSections: BlockedSection[] = [];
    /**
     * Streams cancelled locally (by cancelStream, or by abandoning an
     * over-size section). Small: one entry per cancelled stream, only.
     */
    private readonly cancelledStreams = new Set<number>();

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
        this.maxFieldSectionSize = options.maxFieldSectionSize ?? Infinity;
        this.onDecoderStreamData = options.onDecoderStreamData;
    }

    private queueDecoderStreamData(data: Uint8Array): void {
        if (this.onDecoderStreamData) {
            this.onDecoderStreamData(data);
        } else {
            this.pendingDecoderStreamData.push(data);
        }
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
            // nothing referencing the entries is decoded. State is updated
            // before queueing, as the onDecoderStreamData callback may
            // re-enter the decoder synchronously:
            const increment = this.table.insertCount - this.peerKnownInsertCount;
            this.peerKnownInsertCount = this.table.insertCount;
            this.queueDecoderStreamData(encodePrefixedInt(increment, 6, 0x00));

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

            // Resolve the reference immediately: an invalid name index is an
            // error even while the rest of the instruction is still in flight:
            const name = (firstByte & 0x40)
                ? this.staticEntry(nameIndex.value).name
                : this.insertedEntry(nameIndex.value).name;

            const value = decodeStringLiteral(data, nameIndex.end, 7);
            if (value === null) return null;

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
     *
     * A section exceeding maxFieldSectionSize rejects with
     * FieldSectionTooLargeError; that abandons the whole stream (a Stream
     * Cancellation is emitted, releasing the peer's state), so no further
     * sections can be decoded on it and the caller must reset it.
     */
    decodeFieldSection(streamId: number, data: Uint8Array): Promise<HeaderField[]> {
        try {
            if (this.cancelledStreams.has(streamId)) {
                throw new Error(
                    `Cannot decode a field section on cancelled stream ${streamId}`
                );
            }
            return this.decodeOrBlock(streamId, data);
        } catch (error) {
            // (A too-large rejection of a *blocked* section is handled where
            // it unblocks, in unblockReadySections.)
            if (error instanceof FieldSectionTooLargeError) {
                this.abandonStream(streamId);
            }
            return Promise.reject(error);
        }
    }

    private decodeOrBlock(streamId: number, data: Uint8Array): Promise<HeaderField[]> {
        const requiredInsertCount = this.decodeRequiredInsertCount(data);

        if (requiredInsertCount.value <= this.table.insertCount) {
            return Promise.resolve(
                this.decodeSectionNow(streamId, data, requiredInsertCount)
            );
        }

        // Blocked: wait for the required insertions to arrive. Every field
        // line decodes to at least 8/30 of its wire size (the worst-case
        // Huffman ratio; other forms expand more), so a section that cannot
        // possibly fit the size limit is rejected instead of buffered:
        const wireSize = data.length - requiredInsertCount.end;
        if (wireSize * 8 > this.maxFieldSectionSize * 30) {
            throw this.fieldSectionTooLarge(Math.ceil(wireSize * 8 / 30));
        }

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
        // Sections are removed from the live array before their decode runs:
        // decoding emits acknowledgments, and the onDecoderStreamData
        // callback may re-enter (e.g. cancelStream), so no stale copy of the
        // list can be kept across those calls. Restart the scan after each
        // decode for the same reason.
        let scan = true;
        while (scan) {
            scan = false;
            for (let i = 0; i < this.blockedSections.length; i++) {
                const section = this.blockedSections[i]!;
                if (section.requiredInsertCount.value > this.table.insertCount) {
                    continue;
                }

                this.blockedSections.splice(i, 1);
                try {
                    section.resolve(this.decodeSectionNow(
                        section.streamId,
                        section.data,
                        section.requiredInsertCount
                    ));
                } catch (error) {
                    if (error instanceof FieldSectionTooLargeError) {
                        this.abandonStream(section.streamId);
                    }
                    section.reject(error as Error);
                }
                scan = true;
                break;
            }
        }
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
            // Required Insert Count, so that state is updated before queueing
            // (the onDecoderStreamData callback may re-enter the decoder):
            this.peerKnownInsertCount = Math.max(
                this.peerKnownInsertCount,
                requiredInsertCount.value
            );
            this.queueDecoderStreamData(encodePrefixedInt(streamId, 7, 0x80));
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
        const checkSize = this.maxFieldSectionSize !== Infinity;
        let sectionSize = 0;

        // Reads a string literal within the remaining section size budget:
        // over-budget strings fail before being materialized (see
        // decodeStringLiteral), bounding the work spent on them:
        const readString = (stringOffset: number, prefixBits: number): DecodedString =>
            this.required(decodeStringLiteral(
                data,
                stringOffset,
                prefixBits,
                checkSize ? this.maxFieldSectionSize - sectionSize : Infinity
            ));

        while (offset < data.length) {
            const firstByte = data[offset]!;

            if (firstByte & 0x80) {
                // Indexed field line (T flag: static vs dynamic).
                // Copied, so callers mutating decoded headers can't corrupt
                // the table entries:
                const index = this.required(decodePrefixedInt(data, offset, 6));
                const entry = (firstByte & 0x40)
                    ? this.staticEntry(index.value)
                    : this.dynamicEntry(base - index.value - 1, requiredInsertCount);
                headers.push({ name: entry.name, value: entry.value });
                offset = index.end;
            } else if (firstByte & 0x40) {
                // Literal field line with name reference (N=0x20, T=0x10)
                const index = this.required(decodePrefixedInt(data, offset, 4));
                const name = (firstByte & 0x10)
                    ? this.staticEntry(index.value).name
                    : this.dynamicEntry(base - index.value - 1, requiredInsertCount).name;
                const value = readString(index.end, 7);
                const header: HeaderField = { name, value: value.value };
                if (firstByte & 0x20) header.sensitive = true;
                headers.push(header);
                offset = value.end;
            } else if (firstByte & 0x20) {
                // Literal field line with literal name (N=0x10, H=0x08)
                const name = readString(offset, 3);
                const value = readString(name.end, 7);
                const header: HeaderField = { name: name.value, value: value.value };
                if (firstByte & 0x10) header.sensitive = true;
                headers.push(header);
                offset = value.end;
            } else if (firstByte & 0x10) {
                // Indexed field line with post-base index (copied, as above)
                const index = this.required(decodePrefixedInt(data, offset, 4));
                const entry = this.dynamicEntry(base + index.value, requiredInsertCount);
                headers.push({ name: entry.name, value: entry.value });
                offset = index.end;
            } else {
                // Literal field line with post-base name reference (N=0x08)
                const index = this.required(decodePrefixedInt(data, offset, 3));
                const name = this.dynamicEntry(base + index.value, requiredInsertCount).name;
                const value = readString(index.end, 7);
                const header: HeaderField = { name, value: value.value };
                if (firstByte & 0x08) header.sensitive = true;
                headers.push(header);
                offset = value.end;
            }

            if (checkSize) {
                sectionSize += entrySize(headers[headers.length - 1]!);
                if (sectionSize > this.maxFieldSectionSize) {
                    throw this.fieldSectionTooLarge(sectionSize);
                }
            }
        }

        return headers;
    }

    private fieldSectionTooLarge(size: number): FieldSectionTooLargeError {
        return new FieldSectionTooLargeError(
            this.maxFieldSectionSize,
            `Field section of at least ${size} exceeds our advertised limit ` +
            `of ${this.maxFieldSectionSize}`
        );
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
     * is abandoned and a Stream Cancellation can be emitted. Idempotent, and
     * no further field sections can be decoded on the stream afterwards: the
     * cancellation releases all of the peer encoder's state for the stream,
     * so a later acknowledgment would be a connection error.
     */
    cancelStream(streamId: number): void {
        this.abandonStream(streamId);
    }

    private abandonStream(streamId: number): void {
        if (this.cancelledStreams.has(streamId)) return;
        this.cancelledStreams.add(streamId);

        const cancelled = this.blockedSections.filter((s) => s.streamId === streamId);
        this.blockedSections = this.blockedSections.filter((s) => s.streamId !== streamId);
        for (const section of cancelled) {
            section.reject(new Error(`Stream ${streamId} cancelled while blocked`));
        }

        // With a zero-capacity dynamic table no state can be affected, so we
        // omit cancellations entirely (permitted by RFC 9204 s2.2.2.2):
        if (this.maxTableCapacity === 0) return;

        this.queueDecoderStreamData(encodePrefixedInt(streamId, 6, 0x40));
    }

    /**
     * Drain any pending output for the decoder stream (section
     * acknowledgments, stream cancellations and insert count increments).
     * Returns an empty array if there is nothing to send.
     *
     * New output can be produced by any processEncoderStreamData,
     * decodeFieldSection or cancelStream call, so drain after each of those
     * - or set the onDecoderStreamData option to receive it as it appears,
     * in which case this method is unused.
     */
    takeDecoderStreamData(): Uint8Array {
        if (this.pendingDecoderStreamData.length === 0) return new Uint8Array(0);
        const output = concatBytes(this.pendingDecoderStreamData);
        this.pendingDecoderStreamData = [];
        return output;
    }
}
