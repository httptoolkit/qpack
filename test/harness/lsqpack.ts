import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as url from 'node:url';

import type { HeaderField } from '../../src/index.js';
import { parseDecodedQif } from './qif.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
export const TOOLS_DIR = path.join(HERE, '..', 'tools');
export const QIFS_DIR = path.join(TOOLS_DIR, 'qifs');
export const CORPUS_MANIFEST_PATH = path.join(TOOLS_DIR, 'corpus-manifest.json');

const INTEROP_ENCODE = path.join(TOOLS_DIR, 'bin', 'interop-encode');
const INTEROP_DECODE = path.join(TOOLS_DIR, 'bin', 'interop-decode');

export const MISSING_TOOLS_MESSAGE =
    'Test tools not found - run `npm run setup-test-tools` first';

export function runTool(binary: string, args: string[], stdin: Uint8Array): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const proc = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });

        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        proc.stdout.on('data', (chunk) => stdout.push(chunk));
        proc.stderr.on('data', (chunk) => stderr.push(chunk));

        proc.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') {
                reject(new Error(MISSING_TOOLS_MESSAGE));
            } else {
                reject(error);
            }
        });
        proc.on('close', (code, signal) => {
            if (code !== 0) {
                reject(new Error(
                    `${path.basename(binary)} ${args.join(' ')} failed ` +
                    `(${signal ?? `exit code ${code}`}): ${Buffer.concat(stderr)}`
                ));
            } else {
                resolve(Buffer.concat(stdout));
            }
        });

        // The tool may exit (e.g. on invalid input) before consuming all its
        // input; that shouldn't crash us with EPIPE.
        proc.stdin.on('error', () => {});
        proc.stdin.end(stdin);
    });
}

export interface InteropSettings {
    tableSize: number;
    maxBlocked: number;
}

/**
 * Decodes an interop-format file with ls-qpack's reference decoder, returning
 * the decoded header blocks keyed by stream ID.
 *
 * Uses -S to process blocks in strict file order (without it the tool
 * deliberately reorders blocks to exercise its own blocked-decode paths, and
 * misreports some valid corpus files as errors) and -Q to skip the tool's
 * internal static-table hint assertions (which reject valid encodings that
 * use literals for static-table values, as f5's corpus files do).
 */
export async function lsqpackDecode(
    encoded: Uint8Array,
    settings: InteropSettings
): Promise<Map<number, HeaderField[]>> {
    const output = await runTool(INTEROP_DECODE, [
        '-Q', '-S',
        '-t', String(settings.tableSize),
        '-s', String(settings.maxBlocked)
    ], encoded);
    return parseDecodedQif(output.toString('utf8'));
}

export interface InteropEncodeSettings extends InteropSettings {
    /** 0: never acknowledge, 1: acknowledge every field section immediately */
    ackMode: 0 | 1;
    /** Index more aggressively into the dynamic table */
    aggressive?: boolean;
    /** Never emit Duplicate instructions */
    noDuplicates?: boolean;
}

/**
 * Encodes QIF text with ls-qpack's reference encoder, returning an
 * interop-format file.
 */
export async function lsqpackEncode(
    qifText: string,
    settings: InteropEncodeSettings
): Promise<Uint8Array> {
    const args = [
        '-t', String(settings.tableSize),
        '-s', String(settings.maxBlocked),
        '-a', String(settings.ackMode)
    ];
    if (settings.aggressive) args.push('-A');
    if (settings.noDuplicates) args.push('-D');

    return runTool(INTEROP_ENCODE, args, new TextEncoder().encode(qifText));
}
