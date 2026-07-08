import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { HeaderField } from '../../src/index.js';
import { parseQif } from './qif.js';
import { TOOLS_DIR, runTool, type InteropSettings } from './lsqpack.js';

const NGHTTP3_QPACK = path.join(TOOLS_DIR, 'bin', 'nghttp3-qpack');
const TMP_DIR = path.join(TOOLS_DIR, 'tmp');

let tempCounter = 0;

/** The nghttp3 qpack tool works on files, not stdin/stdout */
async function withTempFiles<T>(
    input: Uint8Array | string,
    run: (inputFile: string, outputFile: string) => Promise<T>
): Promise<T> {
    await fs.mkdir(TMP_DIR, { recursive: true });
    const base = path.join(TMP_DIR, `${process.pid}-${tempCounter++}`);
    await fs.writeFile(`${base}.in`, input);
    try {
        return await run(`${base}.in`, `${base}.out`);
    } finally {
        await fs.rm(`${base}.in`, { force: true });
        await fs.rm(`${base}.out`, { force: true });
    }
}

export interface Nghttp3EncodeSettings extends InteropSettings {
    /** 0: never acknowledge, 1: acknowledge every field section immediately */
    ackMode: 0 | 1;
}

/**
 * Decodes an interop-format file with nghttp3's qpack tool, returning the
 * decoded header blocks in stream order (its output has no stream IDs, but
 * blocks are emitted in stream order even when decodes complete out of
 * order due to blocking).
 */
export async function nghttp3Decode(
    encoded: Uint8Array,
    settings: InteropSettings
): Promise<HeaderField[][]> {
    return withTempFiles(encoded, async (inputFile, outputFile) => {
        await runTool(NGHTTP3_QPACK, [
            'decode',
            '-s', String(settings.tableSize),
            '-m', String(settings.maxBlocked),
            inputFile, outputFile
        ], new Uint8Array(0));
        return parseQif(await fs.readFile(outputFile, 'utf8'));
    });
}

/** Encodes QIF text with nghttp3's qpack tool into an interop-format file */
export async function nghttp3Encode(
    qifText: string,
    settings: Nghttp3EncodeSettings
): Promise<Uint8Array> {
    return withTempFiles(qifText, async (inputFile, outputFile) => {
        const args = [
            'encode',
            '-s', String(settings.tableSize),
            '-m', String(settings.maxBlocked)
        ];
        if (settings.ackMode === 1) args.push('-a');
        args.push(inputFile, outputFile);

        await runTool(NGHTTP3_QPACK, args, new Uint8Array(0));
        return fs.readFile(outputFile);
    });
}
