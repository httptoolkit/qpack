import type { HeaderField } from './types.js';
import { QpackError, FieldSectionTooLargeError } from './errors.js';
import { encodePrefixedInt, decodePrefixedInt } from './prefixed-int.js';
import { encodeStringLiteral, concatBytes } from './strings.js';
import { STATIC_EXACT_MATCHES, STATIC_NAME_MATCHES } from './static-table.js';
import { DynamicTable, entrySize } from './dynamic-table.js';

/**
 * The peer's QPACK-relevant SETTINGS values. In HTTP/3 these usually arrive
 * after encoding has already started (requests are typically sent before the
 * peer's SETTINGS frame is received), so they can also be applied later via
 * setPeerSettings(); until then, the encoder works within the defaults (or
 * any 0-RTT-remembered values passed at construction).
 */
export interface QpackPeerSettings {
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
     * The peer's advertised SETTINGS_MAX_FIELD_SECTION_SIZE: the largest
     * field section (as the uncompressed sum of name + value + 32 per field)
     * it is willing to accept. Defaults to unlimited, per RFC 9114.
     */
    maxFieldSectionSize?: number;
}

export interface QpackEncoderOptions extends QpackPeerSettings {
    /**
     * The dynamic table capacity this encoder should use, capped by the
     * peer's maxTableCapacity whenever that is lower. Defaults to using the
     * peer's full advertised capacity.
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

interface UnackedSection {
    requiredInsertCount: number;
    /** The absolute indexes of the dynamic table entries this section references */
    references: number[];
}

/** How each field line will be represented, decided before emitting */
type FieldLinePlan =
    | { kind: 'indexed-static', index: number }
    | { kind: 'indexed-dynamic', absoluteIndex: number }
    | { kind: 'literal-static-name', index: number, value: string }
    | { kind: 'literal-dynamic-name', absoluteIndex: number, value: string }
    | { kind: 'literal', name: string, value: string };

const NO_BYTES = new Uint8Array(0);

/** Headers seen at least this many times get inserted into the dynamic table */
const HISTORY_LIMIT = 4096;

/**
 * How far insertions may run ahead of the Known Received Count when the new
 * entry can't be referenced immediately. If the decoder is responsive its
 * feedback continually drains this backlog, so insertion keeps flowing (and
 * bootstraps the very first feedback); if no feedback ever arrives (or the
 * peer stops acknowledging) this caps the bytes wasted on insertions that
 * nothing can ever reference.
 */
const UNACKED_INSERT_LIMIT = 16;

export class QpackEncoder {
    private maxTableCapacity: number;
    private maxBlockedStreams: number;
    private maxFieldSectionSize: number;
    /** The capacity the caller asked for, before capping by the peer's max */
    private readonly requestedTableCapacity: number | undefined;
    private readonly useHuffman: boolean;

    private readonly table = new DynamicTable();
    /** The capacity we've told the peer about (0 = no instruction sent yet) */
    private lastSentCapacity = 0;
    /**
     * While the QUIC encoder stream is flow-control blocked, adding more
     * instruction bytes would deadlock any section referencing them, so all
     * insertion (and the capacity instruction) is suspended.
     */
    private backpressure = false;

    /** Newest absolute index per exact name+value in the dynamic table */
    private readonly tableByField = new Map<string, number>();
    /** Newest absolute index per name in the dynamic table */
    private readonly tableByName = new Map<string, number>();
    /** Outstanding section references per entry, blocking its eviction */
    private readonly referenceCounts = new Map<number, number>();

    /**
     * Recently-seen headers: an entry is only worth dynamic table space once
     * it has appeared before, matching ls-qpack's history heuristic.
     */
    private readonly history = new Map<string, boolean>();

    /** How many of our insertions the peer has confirmed receiving */
    private knownReceivedCount = 0;
    /** Sent-but-unacknowledged dynamic-table-referencing sections, per stream */
    private readonly unackedSections = new Map<number, UnackedSection[]>();

    private decoderStreamBuffer = new Uint8Array(0);

    constructor(options: QpackEncoderOptions = {}) {
        this.maxTableCapacity = options.maxTableCapacity ?? 0;
        this.maxBlockedStreams = options.maxBlockedStreams ?? 0;
        this.maxFieldSectionSize = options.maxFieldSectionSize ?? Infinity;
        this.requestedTableCapacity = options.dynamicTableCapacity;
        this.useHuffman = options.useHuffman ?? true;

        this.table.setCapacity(this.tableCapacityToUse);
    }

    /** MaxEntries as defined in RFC 9204 s4.5.1.1 (from the advertised maximum) */
    private get maxEntries(): number {
        return Math.floor(this.maxTableCapacity / 32);
    }

    /** The requested capacity, capped by what the peer currently allows */
    private get tableCapacityToUse(): number {
        return Math.min(
            this.requestedTableCapacity ?? this.maxTableCapacity,
            this.maxTableCapacity
        );
    }

    /**
     * Apply the peer's SETTINGS values once they arrive (or updated 0-RTT
     * values). Only omitted properties keep their current values.
     *
     * Throws if a new value conflicts with encoding state that already
     * exists - which can only happen when the values passed at construction
     * (e.g. remembered 0-RTT settings) were not honoured by the peer. The
     * caller should treat that as an HTTP/3 settings error.
     */
    setPeerSettings(settings: QpackPeerSettings): void {
        const newMaxCapacity = settings.maxTableCapacity ?? this.maxTableCapacity;
        const newMaxBlocked = settings.maxBlockedStreams ?? this.maxBlockedStreams;

        if (newMaxCapacity !== this.maxTableCapacity && this.lastSentCapacity > 0) {
            if (newMaxCapacity < this.lastSentCapacity) {
                throw new Error(
                    `Peer's max table capacity (${newMaxCapacity}) is below the ` +
                    `dynamic table capacity already in use (${this.lastSentCapacity})`
                );
            }
            // MaxEntries (from the peer's advertised capacity) defines the
            // modulus for Required Insert Count encoding. Sections already
            // sent used the old value; they only decode identically under
            // the new one if no wrapped encodings exist yet:
            if (this.table.insertCount >= 2 * this.maxEntries) {
                throw new Error(
                    `Cannot adopt a changed max table capacity after ` +
                    `${this.table.insertCount} insertions: sent field sections ` +
                    `already depend on the previous MaxEntries value`
                );
            }
        }

        if (newMaxBlocked < this.maxBlockedStreams
            && this.countStreamsAtRisk() > newMaxBlocked
        ) {
            throw new Error(
                `Peer's max blocked streams (${newMaxBlocked}) is below the ` +
                `number of streams already at risk (${this.countStreamsAtRisk()})`
            );
        }

        this.maxTableCapacity = newMaxCapacity;
        this.maxBlockedStreams = newMaxBlocked;
        this.maxFieldSectionSize = settings.maxFieldSectionSize ?? this.maxFieldSectionSize;

        this.table.setCapacity(this.tableCapacityToUse);
    }

    /**
     * Notify the encoder of backpressure on the QUIC encoder stream: while
     * active, no new encoder stream bytes are produced (no insertions, so
     * compression is temporarily reduced), as writing instructions that
     * can't be delivered would block every field section referencing them.
     */
    setEncoderStreamBackpressure(active: boolean): void {
        this.backpressure = active;
    }

    encodeFieldSection(streamId: number, headers: HeaderField[]): EncodedFieldSection {
        // Enforced before any state changes, so a rejected section leaves
        // the encoder fully usable:
        const sectionSize = headers.reduce((sum, field) => sum + entrySize(field), 0);
        if (sectionSize > this.maxFieldSectionSize) {
            throw new FieldSectionTooLargeError(
                this.maxFieldSectionSize,
                `Field section of size ${sectionSize} exceeds the peer's ` +
                `advertised limit of ${this.maxFieldSectionSize}`
            );
        }

        const encoderStream: Uint8Array[] = [];

        if (!this.backpressure && this.lastSentCapacity !== this.tableCapacityToUse) {
            // Set Dynamic Table Capacity, required before any use of the
            // table as its initial capacity is 0 (RFC 9204 s3.2.3), and
            // again if the usable capacity has since grown (e.g. once the
            // peer's real SETTINGS arrived). Always emitted ahead of any
            // insertions relying on it:
            encoderStream.push(encodePrefixedInt(this.tableCapacityToUse, 5, 0x20));
            this.lastSentCapacity = this.tableCapacityToUse;
        }

        // A section referencing any unacknowledged entry can block, which is
        // only allowed within the peer's blocked-streams budget. A stream
        // already at risk from an earlier section doesn't count twice:
        let canRisk = this.isStreamAtRisk(streamId)
            || this.countStreamsAtRisk() < this.maxBlockedStreams;

        // First pass: choose representations, inserting into the dynamic
        // table where profitable. All insertions happen before the section
        // is emitted, so the section's Base can cover every reference:
        const plans: FieldLinePlan[] = [];
        const references: number[] = [];
        // Entries this section references must survive (unevicted) until the
        // whole section is emitted, including through insertions made for
        // later field lines of this same section:
        const pinned = new Set<number>();

        const refer = (absoluteIndex: number) => {
            references.push(absoluteIndex);
            pinned.add(absoluteIndex);
            if (absoluteIndex >= this.knownReceivedCount) canRisk = true;
        };

        for (const field of headers) {
            const plan = this.planFieldLine(field, canRisk, encoderStream, refer, pinned);
            plans.push(plan);
        }

        // Second pass: emit the section. Base = Required Insert Count, so
        // every reference is relative (no post-base forms needed):
        const requiredInsertCount = references.length > 0
            ? Math.max(...references) + 1
            : 0;
        const base = requiredInsertCount;

        const parts: Uint8Array[] = [
            encodePrefixedInt(
                requiredInsertCount === 0
                    ? 0
                    : (requiredInsertCount % (2 * this.maxEntries)) + 1,
                8
            ),
            encodePrefixedInt(0, 7) // Sign 0, Delta Base 0
        ];

        for (const plan of plans) {
            switch (plan.kind) {
                case 'indexed-static':
                    parts.push(encodePrefixedInt(plan.index, 6, 0xc0));
                    break;
                case 'indexed-dynamic':
                    parts.push(encodePrefixedInt(base - plan.absoluteIndex - 1, 6, 0x80));
                    break;
                case 'literal-static-name':
                    parts.push(encodePrefixedInt(plan.index, 4, 0x50));
                    parts.push(encodeStringLiteral(plan.value, 7, 0, this.useHuffman));
                    break;
                case 'literal-dynamic-name':
                    parts.push(encodePrefixedInt(base - plan.absoluteIndex - 1, 4, 0x40));
                    parts.push(encodeStringLiteral(plan.value, 7, 0, this.useHuffman));
                    break;
                case 'literal':
                    parts.push(encodeStringLiteral(plan.name, 3, 0x20, this.useHuffman));
                    parts.push(encodeStringLiteral(plan.value, 7, 0, this.useHuffman));
                    break;
            }
        }

        if (requiredInsertCount > 0) {
            for (const reference of references) {
                this.referenceCounts.set(
                    reference,
                    (this.referenceCounts.get(reference) ?? 0) + 1
                );
            }
            let sections = this.unackedSections.get(streamId);
            if (!sections) {
                sections = [];
                this.unackedSections.set(streamId, sections);
            }
            sections.push({ requiredInsertCount, references });
        }

        return {
            fieldSection: concatBytes(parts),
            encoderStreamData: encoderStream.length > 0
                ? concatBytes(encoderStream)
                : NO_BYTES
        };
    }

    private planFieldLine(
        field: HeaderField,
        canRisk: boolean,
        encoderStream: Uint8Array[],
        refer: (absoluteIndex: number) => void,
        pinned: Set<number>
    ): FieldLinePlan {
        const { name, value } = field;

        const staticExact = STATIC_EXACT_MATCHES.get(`${name}\0${value}`);
        if (staticExact !== undefined) {
            return { kind: 'indexed-static', index: staticExact };
        }

        const staticName = STATIC_NAME_MATCHES.get(name);
        const literalPlan = (): FieldLinePlan => {
            if (staticName !== undefined) {
                return { kind: 'literal-static-name', index: staticName, value };
            }
            // A dynamic name reference also counts as a (potentially
            // blocking, eviction-pinning) reference to that entry:
            const nameMatch = this.liveIndex(this.tableByName, name);
            if (nameMatch !== null && !this.isDraining(nameMatch)
                && (nameMatch < this.knownReceivedCount || canRisk)
            ) {
                refer(nameMatch);
                return { kind: 'literal-dynamic-name', absoluteIndex: nameMatch, value };
            }
            return { kind: 'literal', name, value };
        };

        if (this.lastSentCapacity === 0) return literalPlan();

        const fieldKey = `${name}\0${value}`;
        const exactMatch = this.liveIndex(this.tableByField, fieldKey);

        // Insertion requires encoder stream budget (no backpressure), an
        // entry plausibly worth the space, and room without evicting
        // anything referenced:
        const worthInserting = !this.backpressure && (
            canRisk
            || this.table.insertCount - this.knownReceivedCount < UNACKED_INSERT_LIMIT
        );
        const canInsertNow = worthInserting && this.canInsert(field, pinned, canRisk);

        if (exactMatch !== null
            && (exactMatch < this.knownReceivedCount || canRisk)
            && !(this.isDraining(exactMatch) && canInsertNow)
        ) {
            // Usable directly. (A draining match is still referenced rather
            // than falling back to a literal, unless it can be refreshed
            // with a Duplicate below.)
            refer(exactMatch);
            return { kind: 'indexed-dynamic', absoluteIndex: exactMatch };
        }

        // Not (usably) in the table. Insert if it has appeared before, in
        // the hope of future repeats; reference the new entry if we may:
        const seenBefore = this.history.has(fieldKey);
        this.recordInHistory(fieldKey);

        if (seenBefore && canInsertNow) {
            if (exactMatch !== null) {
                // A draining exact match: refresh it with a Duplicate
                encoderStream.push(encodePrefixedInt(
                    this.table.insertCount - exactMatch - 1, 5, 0x00
                ));
            } else {
                const nameMatch = this.liveIndex(this.tableByName, name);
                if (staticName !== undefined) {
                    // Insert with static name reference
                    encoderStream.push(encodePrefixedInt(staticName, 6, 0xc0));
                    encoderStream.push(encodeStringLiteral(value, 7, 0, this.useHuffman));
                } else if (nameMatch !== null) {
                    // Insert with dynamic name reference
                    encoderStream.push(encodePrefixedInt(
                        this.table.insertCount - nameMatch - 1, 6, 0x80
                    ));
                    encoderStream.push(encodeStringLiteral(value, 7, 0, this.useHuffman));
                } else {
                    // Insert with literal name
                    encoderStream.push(encodeStringLiteral(name, 5, 0x40, this.useHuffman));
                    encoderStream.push(encodeStringLiteral(value, 7, 0, this.useHuffman));
                }
            }

            this.table.insert(field);
            const newIndex = this.table.insertCount - 1;
            this.tableByField.set(fieldKey, newIndex);
            this.tableByName.set(name, newIndex);

            if (canRisk) {
                refer(newIndex);
                return { kind: 'indexed-dynamic', absoluteIndex: newIndex };
            }
        }

        return literalPlan();
    }

    /** Looks up a tracked index, ignoring entries that have been evicted */
    private liveIndex(map: Map<string, number>, key: string): number | null {
        const index = map.get(key);
        if (index === undefined) return null;
        if (this.table.get(index) === null) {
            map.delete(key);
            return null;
        }
        return index;
    }

    /**
     * Entries close to eviction shouldn't gain new references (which would
     * pin them and jam the table): the oldest eighth of the capacity is
     * treated as draining.
     */
    private isDraining(absoluteIndex: number): boolean {
        const drainingLimit = this.table.capacity / 8;
        let drained = 0;
        for (let i = this.table.firstIndex; i <= absoluteIndex; i++) {
            drained += entrySize(this.table.get(i)!);
            if (drained > drainingLimit) return false;
        }
        return true;
    }

    /**
     * Whether an entry can be inserted without evicting anything that has
     * outstanding references (which is never permitted: RFC 9204 s2.1.1),
     * including references made by the section currently being encoded.
     */
    private canInsert(
        field: HeaderField,
        pinned: Set<number>,
        allowEviction: boolean
    ): boolean {
        const size = entrySize(field);
        if (size > this.table.capacity) return false;

        let toFree = this.table.size + size - this.table.capacity;

        // An entry that can't be referenced until feedback arrives isn't
        // worth evicting entries that are already earning their keep - that
        // just churns the table. Speculative insertions only use free space:
        if (toFree > 0 && !allowEviction) return false;

        for (let i = this.table.firstIndex; toFree > 0; i++) {
            if ((this.referenceCounts.get(i) ?? 0) > 0 || pinned.has(i)) return false;
            toFree -= entrySize(this.table.get(i)!);
        }
        return true;
    }

    private isStreamAtRisk(streamId: number): boolean {
        return (this.unackedSections.get(streamId) ?? []).some(
            (section) => section.requiredInsertCount > this.knownReceivedCount
        );
    }

    private countStreamsAtRisk(): number {
        let count = 0;
        for (const sections of this.unackedSections.values()) {
            if (sections.some((s) => s.requiredInsertCount > this.knownReceivedCount)) {
                count++;
            }
        }
        return count;
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
            this.cancelSections(streamId.value);
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

        const section = sections.shift()!;
        if (sections.length === 0) this.unackedSections.delete(streamId);
        this.releaseReferences(section);

        // Acknowledging a section implicitly acknowledges every insertion up
        // to its Required Insert Count:
        this.knownReceivedCount = Math.max(
            this.knownReceivedCount,
            section.requiredInsertCount
        );
    }

    private cancelSections(streamId: number): void {
        const sections = this.unackedSections.get(streamId) ?? [];
        this.unackedSections.delete(streamId);
        for (const section of sections) this.releaseReferences(section);
    }

    private releaseReferences(section: UnackedSection): void {
        for (const reference of section.references) {
            const count = this.referenceCounts.get(reference)!;
            if (count === 1) this.referenceCounts.delete(reference);
            else this.referenceCounts.set(reference, count - 1);
        }
    }

    private increaseKnownReceivedCount(increment: number): void {
        if (increment === 0
            || this.knownReceivedCount + increment > this.table.insertCount
        ) {
            throw new QpackError(
                'QPACK_DECODER_STREAM_ERROR',
                `Invalid insert count increment (${increment}, with ` +
                `${this.knownReceivedCount} of ${this.table.insertCount} ` +
                `insertions acknowledged)`
            );
        }
        this.knownReceivedCount += increment;
    }

    private recordInHistory(fieldKey: string): void {
        if (this.history.size >= HISTORY_LIMIT) {
            // Discard the older half, preserving recently-seen entries:
            let toDelete = this.history.size / 2;
            for (const key of this.history.keys()) {
                if (toDelete-- <= 0) break;
                this.history.delete(key);
            }
        }
        this.history.set(fieldKey, true);
    }
}
