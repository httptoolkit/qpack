import { expect } from 'chai';

import { QpackDecoder, type HeaderField } from '../src/index.js';
import { qit, withTimeout } from './harness/disabled.js';
import { loadCorpusManifest, readCorpusFile, readReferenceDecoding } from './harness/corpus.js';
import {
    readInteropBlocks,
    impliedCapacityInstruction,
    ENCODER_STREAM_ID
} from './harness/framing.js';
import { sortedBlockEntries } from './harness/utils.js';

const manifest = await loadCorpusManifest();

/**
 * Decodes every third-party encoded file in the qifs corpus, and checks the
 * result exactly matches the reference (ls-qpack) decoding, which was itself
 * validated against the original QIF inputs when the manifest was built.
 */
describe('corpus decode', () => {

    for (const corpusCase of manifest.cases) {
        if (!corpusCase.referenceOk) continue;

        qit(`${corpusCase.id} (table size ${corpusCase.tableSize})`, async () => {
            const encoded = await readCorpusFile(corpusCase.encodedPath);
            const blocks = readInteropBlocks(encoded);

            const decoder = new QpackDecoder({
                maxTableCapacity: corpusCase.tableSize,
                maxBlockedStreams: corpusCase.maxBlocked
            });
            decoder.processEncoderStreamData(
                impliedCapacityInstruction(corpusCase.tableSize)
            );

            // Process blocks strictly in file order. Field sections may be
            // received before the insertions they reference (that's how the
            // corpus exercises blocked streams), so decodes are collected
            // and awaited only after everything has been fed in:
            const decodes: Array<Promise<[number, HeaderField[]]>> = [];
            for (const block of blocks) {
                if (block.streamId === ENCODER_STREAM_ID) {
                    decoder.processEncoderStreamData(block.data);
                } else {
                    const decode = decoder.decodeFieldSection(block.streamId, block.data)
                        .then((headers): [number, HeaderField[]] => [block.streamId, headers]);
                    // Errors surface via Promise.all below; this just avoids
                    // unhandled rejections if a later block throws first:
                    decode.catch(() => {});
                    decodes.push(decode);
                }
            }

            const decoded = new Map(await withTimeout(Promise.all(decodes), 5000));
            const expected = await readReferenceDecoding(corpusCase);
            expect(sortedBlockEntries(decoded)).to.deep.equal(sortedBlockEntries(expected));
        });
    }

});
