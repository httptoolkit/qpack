import type { HeaderField } from './types.js';

export const ENTRY_OVERHEAD = 32;

export function entrySize(field: HeaderField): number {
    return field.name.length + field.value.length + ENTRY_OVERHEAD;
}

/**
 * A QPACK dynamic table (RFC 9204 section 3.2): entries indexed by absolute
 * insertion number, with size-based eviction of the oldest entries.
 */
export class DynamicTable {
    private entries: HeaderField[] = [];
    /** The number of evicted entries, i.e. the absolute index of entries[0] */
    private evictedCount = 0;
    private currentSize = 0;
    private currentCapacity = 0;

    /** The total number of insertions ever made */
    get insertCount(): number {
        return this.evictedCount + this.entries.length;
    }

    get size(): number {
        return this.currentSize;
    }

    get capacity(): number {
        return this.currentCapacity;
    }

    setCapacity(capacity: number): void {
        this.currentCapacity = capacity;
        this.evictToSize(capacity);
    }

    /** Whether an entry of this size can ever fit in the table */
    canFit(size: number): boolean {
        return size <= this.currentCapacity;
    }

    /** Inserts an entry, evicting the oldest entries as needed to make room */
    insert(field: HeaderField): void {
        const size = entrySize(field);
        if (!this.canFit(size)) {
            throw new Error(`Entry of size ${size} cannot fit in table of ` +
                `capacity ${this.currentCapacity}`);
        }
        this.evictToSize(this.currentCapacity - size);
        this.entries.push(field);
        this.currentSize += size;
    }

    /** Returns the entry at an absolute index, or null if evicted/not present */
    get(absoluteIndex: number): HeaderField | null {
        const index = absoluteIndex - this.evictedCount;
        if (index < 0 || index >= this.entries.length) return null;
        return this.entries[index]!;
    }

    private evictToSize(targetSize: number): void {
        while (this.currentSize > targetSize) {
            const evicted = this.entries.shift()!;
            this.evictedCount++;
            this.currentSize -= entrySize(evicted);
        }
    }
}
