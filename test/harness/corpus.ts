import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { HeaderField } from '../../src/index.js';
import { parseDecodedQif } from './qif.js';
import { TOOLS_DIR, CORPUS_MANIFEST_PATH, MISSING_TOOLS_MESSAGE } from './lsqpack.js';

/**
 * One encoded file from the qifs corpus: another implementation's QPACK
 * output, to be decoded and compared against the reference decoding.
 */
export interface CorpusCase {
    /** e.g. 'qpack-06/nghttp3/fb-req.out.4096.100.1' */
    id: string;
    /** Path of the encoded file, relative to the qifs repo root */
    encodedPath: string;
    tableSize: number;
    maxBlocked: number;
    ackMode: number;
    /** Path of the source QIF relative to the qifs repo root, if known */
    qifPath: string | null;
    /**
     * Whether ls-qpack's reference decoder successfully decoded this file
     * and (where a source QIF exists) the result matched it. Cases where
     * this is false are excluded from decode tests, with the reason here.
     */
    referenceOk: boolean;
    note?: string;
    /**
     * Whether nghttp3's decoder also successfully decoded this file to the
     * same result, as a second independent validation of the corpus.
     */
    nghttp3Ok: boolean;
    nghttp3Note?: string;
    /** Path of the reference-decoded output, relative to test/tools */
    decodedPath: string | null;
}

/** One file from the corpus's encoded/errors directory */
export interface ErrorCase {
    id: string;
    encodedPath: string;
    /** Whether ls-qpack's reference decoder rejects this file (at 4096/100) */
    rejectedByReference: boolean;
}

export interface CorpusManifest {
    qifsCommit: string;
    lsqpackVersion: string;
    cases: CorpusCase[];
    errorCases: ErrorCase[];
}

export async function loadCorpusManifest(): Promise<CorpusManifest> {
    let content: string;
    try {
        content = await fs.readFile(CORPUS_MANIFEST_PATH, 'utf8');
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error(MISSING_TOOLS_MESSAGE);
        }
        throw error;
    }
    return JSON.parse(content) as CorpusManifest;
}

export async function readCorpusFile(relativePath: string): Promise<Uint8Array> {
    return fs.readFile(path.join(TOOLS_DIR, 'qifs', relativePath));
}

export async function readReferenceDecoding(
    corpusCase: CorpusCase
): Promise<Map<number, HeaderField[]>> {
    if (!corpusCase.decodedPath) {
        throw new Error(`No reference decoding available for ${corpusCase.id}`);
    }
    const text = await fs.readFile(path.join(TOOLS_DIR, corpusCase.decodedPath), 'utf8');
    return parseDecodedQif(text);
}

export async function readQif(qifPath: string): Promise<string> {
    return fs.readFile(path.join(TOOLS_DIR, 'qifs', qifPath), 'utf8');
}

/** The source QIF files used by the corpus and generated round-trip tests */
export const QIF_NAMES = [
    'fb-req', 'fb-req-hq',
    'fb-resp', 'fb-resp-hq',
    'netbsd', 'netbsd-hq'
] as const;
