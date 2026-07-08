import type { HeaderField } from '../../src/index.js';

/**
 * Parses QIF text (https://github.com/qpackers/qifs#qif-format): one header
 * field per line as "name<TAB>value", '#' comment lines ignored, blank line
 * ends each header block.
 */
export function parseQif(text: string): HeaderField[][] {
    const blocks: HeaderField[][] = [];
    let current: HeaderField[] = [];

    for (const line of text.split('\n')) {
        if (line.startsWith('#')) continue;
        if (line === '') {
            if (current.length > 0) {
                blocks.push(current);
                current = [];
            }
            continue;
        }

        const tabIndex = line.indexOf('\t');
        if (tabIndex === -1) {
            current.push({ name: line, value: '' });
        } else {
            current.push({
                name: line.slice(0, tabIndex),
                value: line.slice(tabIndex + 1)
            });
        }
    }
    if (current.length > 0) blocks.push(current);

    return blocks;
}

export function serializeQif(blocks: HeaderField[][]): string {
    return blocks.map((block) =>
        block.map((field) => `${field.name}\t${field.value}`).join('\n') + '\n'
    ).join('\n');
}

/**
 * Parses the QIF-like output of ls-qpack's interop-decode, where each block
 * is preceded by a "# stream N" comment. Blocks may appear out of stream
 * order (blocked streams complete late), so results are keyed by stream ID.
 */
export function parseDecodedQif(text: string): Map<number, HeaderField[]> {
    const blocks = new Map<number, HeaderField[]>();
    let current: HeaderField[] = [];
    let streamId: number | null = null;

    const finishBlock = () => {
        if (current.length === 0) return;
        if (streamId === null) throw new Error('Decoded block with no stream ID comment');
        if (blocks.has(streamId)) throw new Error(`Duplicate decoded block for stream ${streamId}`);
        blocks.set(streamId, current);
        current = [];
        streamId = null;
    };

    for (const line of text.split('\n')) {
        const streamMatch = /^# stream (\d+)/.exec(line);
        if (streamMatch) {
            streamId = parseInt(streamMatch[1]!, 10);
            continue;
        }
        if (line.startsWith('#')) continue;
        if (line === '') {
            finishBlock();
            continue;
        }

        const tabIndex = line.indexOf('\t');
        if (tabIndex === -1) {
            current.push({ name: line, value: '' });
        } else {
            current.push({
                name: line.slice(0, tabIndex),
                value: line.slice(tabIndex + 1)
            });
        }
    }
    finishBlock();

    return blocks;
}

/**
 * Returns decoded blocks as an array ordered by stream ID, for comparison
 * against the source QIF's blocks (encoders assign ascending stream IDs to
 * QIF blocks in order).
 */
export function decodedBlocksInStreamOrder(blocks: Map<number, HeaderField[]>): HeaderField[][] {
    return [...blocks.keys()].sort((a, b) => a - b).map((id) => blocks.get(id)!);
}
