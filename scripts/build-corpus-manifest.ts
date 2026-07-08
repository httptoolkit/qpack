/**
 * Builds test/tools/corpus-manifest.json by running ls-qpack's reference
 * decoder over every encoded file in the qifs corpus. This both validates
 * the corpus against an RFC 9204 implementation (excluding any files the
 * reference itself cannot decode, with the reason recorded) and captures
 * the reference decodings that our decoder's output is compared against.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { parseQif, decodedBlocksInStreamOrder, serializeQif } from '../test/harness/qif.js';
import { lsqpackDecode, TOOLS_DIR, QIFS_DIR, CORPUS_MANIFEST_PATH } from '../test/harness/lsqpack.js';
import { nghttp3Decode } from '../test/harness/nghttp3.js';
import type { CorpusCase, CorpusManifest, ErrorCase } from '../test/harness/corpus.js';

const ENCODED_DIR = 'encoded/qpack-06';
const ERRORS_DIR = 'encoded/errors';
const DECODED_DIR = path.join(TOOLS_DIR, 'decoded');

// Corpus files without settings in their filename get defaults that are
// large enough for any of the corpus's encodings:
const DEFAULT_TABLE_SIZE = 4096;
const DEFAULT_MAX_BLOCKED = 100;

async function listCorpusFiles(): Promise<string[]> {
    const root = path.join(QIFS_DIR, ENCODED_DIR);
    const files: string[] = [];
    for (const entry of await fs.readdir(root, { withFileTypes: true, recursive: true })) {
        if (entry.isFile()) {
            const absolute = path.join(entry.parentPath, entry.name);
            files.push(path.relative(QIFS_DIR, absolute));
        }
    }
    return files.sort();
}

async function buildCase(encodedPath: string): Promise<CorpusCase> {
    const filename = path.basename(encodedPath);
    const settingsMatch = /^(.+)\.out\.(\d+)\.(\d+)\.(\d+)$/.exec(filename);

    const qifName = settingsMatch ? settingsMatch[1]! : filename.replace(/\.out$/, '');
    const tableSize = settingsMatch ? parseInt(settingsMatch[2]!, 10) : DEFAULT_TABLE_SIZE;
    const maxBlocked = settingsMatch ? parseInt(settingsMatch[3]!, 10) : DEFAULT_MAX_BLOCKED;
    const ackMode = settingsMatch ? parseInt(settingsMatch[4]!, 10) : 0;

    let qifPath: string | null = `qifs/${qifName}.qif`;
    const qifText = await fs.readFile(path.join(QIFS_DIR, qifPath), 'utf8')
        .catch(() => null);
    if (qifText === null) qifPath = null;

    const corpusCase: CorpusCase = {
        id: encodedPath.replace(/^encoded\//, ''),
        encodedPath,
        tableSize,
        maxBlocked,
        ackMode,
        qifPath,
        referenceOk: false,
        nghttp3Ok: false,
        decodedPath: null
    };

    const encoded = await fs.readFile(path.join(QIFS_DIR, encodedPath));
    let decoded;
    try {
        decoded = await lsqpackDecode(encoded, { tableSize, maxBlocked });
    } catch (error) {
        corpusCase.note = `Reference decoder rejected this file: ${(error as Error).message}`;
        return corpusCase;
    }

    const decodedPath = path.join('decoded', `${corpusCase.id}.qif`);
    const outputFile = path.join(TOOLS_DIR, decodedPath);
    await fs.mkdir(path.dirname(outputFile), { recursive: true });

    const decodedBlocks = decodedBlocksInStreamOrder(decoded);
    const streamIds = [...decoded.keys()].sort((a, b) => a - b);
    const output = streamIds.map((id, i) =>
        `# stream ${id}\n` + serializeQif([decodedBlocks[i]!])
    ).join('\n');
    await fs.writeFile(outputFile, output);
    corpusCase.decodedPath = decodedPath;

    // Second, independent validation of the same file with nghttp3:
    try {
        const nghttp3Blocks = await nghttp3Decode(encoded, { tableSize, maxBlocked });
        if (JSON.stringify(nghttp3Blocks) === JSON.stringify(decodedBlocks)) {
            corpusCase.nghttp3Ok = true;
        } else {
            corpusCase.nghttp3Note = 'nghttp3 decoding does not match';
        }
    } catch (error) {
        corpusCase.nghttp3Note = `nghttp3 rejected this file: ${(error as Error).message}`;
    }

    if (qifText === null) {
        corpusCase.referenceOk = true;
        corpusCase.note = 'No source QIF in the corpus; the reference decoding ' +
            'alone is used as the expected output';
        return corpusCase;
    }

    const expectedBlocks = parseQif(qifText);
    if (JSON.stringify(expectedBlocks) === JSON.stringify(decodedBlocks)) {
        corpusCase.referenceOk = true;
    } else {
        corpusCase.note = 'Reference decoding does not match the source QIF';
    }
    return corpusCase;
}

async function buildErrorCase(encodedPath: string): Promise<ErrorCase> {
    const encoded = await fs.readFile(path.join(QIFS_DIR, encodedPath));
    let rejected = false;
    try {
        await lsqpackDecode(encoded, {
            tableSize: DEFAULT_TABLE_SIZE,
            maxBlocked: DEFAULT_MAX_BLOCKED
        });
    } catch {
        rejected = true;
    }
    return {
        id: encodedPath.replace(/^encoded\//, ''),
        encodedPath,
        rejectedByReference: rejected
    };
}

async function mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<R>
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let nextIndex = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await fn(items[index]!);
        }
    }));
    return results;
}

const pins = (await fs.readFile(path.join(TOOLS_DIR, '.pins'), 'utf8')).trim().split(' ');

await fs.rm(DECODED_DIR, { recursive: true, force: true });

const corpusFiles = await listCorpusFiles();
const cases = await mapWithConcurrency(corpusFiles, 8, buildCase);

const errorFiles = (await fs.readdir(path.join(QIFS_DIR, ERRORS_DIR)))
    .sort()
    .map((name) => `${ERRORS_DIR}/${name}`);
const errorCases = await mapWithConcurrency(errorFiles, 8, buildErrorCase);

const manifest: CorpusManifest = {
    qifsCommit: pins[0]!,
    lsqpackVersion: pins[1]!,
    cases,
    errorCases
};
await fs.writeFile(CORPUS_MANIFEST_PATH, JSON.stringify(manifest, null, 2));

const excluded = cases.filter((c) => !c.referenceOk);
const nghttp3Disagreements = cases.filter((c) => c.referenceOk && !c.nghttp3Ok);
console.log(
    `Corpus manifest built: ${cases.length} cases ` +
    `(${excluded.length} excluded, ${nghttp3Disagreements.length} nghttp3 ` +
    `disagreements), ${errorCases.length} error cases ` +
    `(${errorCases.filter((c) => c.rejectedByReference).length} rejected by reference)`
);
for (const c of excluded) console.log(`  excluded: ${c.id}: ${c.note}`);
for (const c of nghttp3Disagreements) console.log(`  nghttp3: ${c.id}: ${c.nghttp3Note}`);
