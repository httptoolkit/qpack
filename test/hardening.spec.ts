import { expect } from 'chai';

import { QpackDecoder, QpackError, type HeaderField } from '../src/index.js';

import { loadCorpusManifest, readCorpusFile, readReferenceDecoding } from './harness/corpus.js';
import {
    readInteropBlocks,
    impliedCapacityInstruction,
    ENCODER_STREAM_ID
} from './harness/framing.js';
import { sortedBlockEntries } from './harness/utils.js';

const manifest = await loadCorpusManifest();

/**
 * Robustness tests: whatever bytes arrive, the decoder must fail with a
 * QpackError (or keep legitimately waiting for more data) - never crash
 * with another error type, hang, or invent wrong output.
 */
describe('hardening', function () {
    this.timeout(30000);

    // A representative spread: different implementations, table sizes and
    // blocking/ack modes:
    const SAMPLE_CASES = [
        'qpack-06/ls-qpack/fb-req.out.4096.100.1',
        'qpack-06/nghttp3/netbsd.out.256.100.0',
        'qpack-06/f5/fb-resp.out.512.0.1',
        'qpack-06/qthingey/netbsd-hq.out.0.0.0'
    ];

    /**
     * Decodes with a verdict, distinguishing valid outcomes from broken ones.
     * Undecodable input must produce a QpackError; incomplete-looking input
     * may also block (waiting for insertions that never come).
     */
    const tryDecode = async (
        decoder: QpackDecoder,
        streamId: number,
        data: Uint8Array
    ): Promise<
        | { outcome: 'decoded', headers: HeaderField[] }
        | { outcome: 'rejected' }
        | { outcome: 'pending' }
    > => {
        try {
            const result = await Promise.race([
                decoder.decodeFieldSection(streamId, data),
                new Promise<'pending'>((resolve) =>
                    setTimeout(() => resolve('pending'), 10)
                )
            ]);
            if (result === 'pending') return { outcome: 'pending' };
            return { outcome: 'decoded', headers: result };
        } catch (error) {
            if (!(error instanceof QpackError)) {
                throw new Error(`Rejected with a non-QpackError error: ${error}`);
            }
            return { outcome: 'rejected' };
        }
    };

    for (const caseId of SAMPLE_CASES) {
        it(`every truncation of ${caseId} fails cleanly`, async () => {
            const corpusCase = manifest.cases.find((c) => c.id === caseId)!;
            expect(corpusCase).to.not.equal(undefined);

            const blocks = readInteropBlocks(await readCorpusFile(corpusCase.encodedPath));
            const expected = await readReferenceDecoding(corpusCase);

            const decoder = new QpackDecoder({
                maxTableCapacity: corpusCase.tableSize,
                maxBlockedStreams: corpusCase.maxBlocked + 1000 // Room for truncated extras
            });
            decoder.processEncoderStreamData(
                impliedCapacityInstruction(corpusCase.tableSize)
            );

            // Process blocks in their real order (sections can only be
            // decoded while the entries they reference are still live), and
            // check every prefix of the first few field sections as they
            // arrive. A prefix must either decode to a prefix of the real
            // headers (field lines are self-delimiting), reject with a
            // QpackError, or block awaiting insertions:
            let truncatedId = 1_000_000; // Distinct from real stream IDs
            let sectionsChecked = 0;
            const fullDecodes: Array<Promise<void>> = [];

            for (const block of blocks) {
                if (block.streamId === ENCODER_STREAM_ID) {
                    decoder.processEncoderStreamData(block.data);
                    continue;
                }

                if (sectionsChecked < 3) {
                    sectionsChecked++;
                    const fullHeaders = expected.get(block.streamId)!;

                    const step = Math.max(1, Math.floor(block.data.length / 100));
                    for (let length = 0; length < block.data.length; length += step) {
                        const result = await tryDecode(
                            decoder,
                            truncatedId++,
                            block.data.subarray(0, length)
                        );
                        if (result.outcome === 'decoded') {
                            expect(result.headers, `prefix of length ${length}`)
                                .to.deep.equal(fullHeaders.slice(0, result.headers.length));
                        }
                    }
                }

                // Every complete section must still decode correctly (some
                // resolve only once later insertions arrive):
                const decode = decoder.decodeFieldSection(block.streamId, block.data)
                    .then((headers) => {
                        expect(headers).to.deep.equal(expected.get(block.streamId));
                    });
                decode.catch(() => {});
                fullDecodes.push(decode);
            }

            await Promise.all(fullDecodes);
        });
    }

    it('random garbage field sections fail cleanly', async () => {
        let state = 0xc0ffee42;
        const nextByte = () => {
            state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
            state >>>= 0;
            return state & 0xff;
        };

        const decoder = new QpackDecoder({
            maxTableCapacity: 4096,
            maxBlockedStreams: 10000
        });
        decoder.processEncoderStreamData(impliedCapacityInstruction(4096));

        for (let run = 0; run < 500; run++) {
            const data = Uint8Array.from({ length: run % 64 }, nextByte);
            // Any outcome tryDecode allows is fine; it throws on wrong ones:
            await tryDecode(decoder, run + 1, data);
        }
    });

    it('random garbage encoder stream data fails cleanly', () => {
        let state = 0xabad1dea;
        const nextByte = () => {
            state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
            state >>>= 0;
            return state & 0xff;
        };

        for (let run = 0; run < 500; run++) {
            const decoder = new QpackDecoder({
                maxTableCapacity: 4096,
                maxBlockedStreams: 100
            });
            const data = Uint8Array.from({ length: run % 64 }, nextByte);
            try {
                decoder.processEncoderStreamData(data);
            } catch (error) {
                if (!(error instanceof QpackError)) {
                    throw new Error(`Rejected with a non-QpackError error: ${error}`);
                }
            }
        }
    });

    it('encoder stream data can arrive one byte at a time', async () => {
        const corpusCase = manifest.cases.find(
            (c) => c.id === 'qpack-06/ls-qpack/fb-req.out.4096.100.1'
        )!;
        const blocks = readInteropBlocks(await readCorpusFile(corpusCase.encodedPath));

        const decoder = new QpackDecoder({
            maxTableCapacity: corpusCase.tableSize,
            maxBlockedStreams: corpusCase.maxBlocked
        });
        decoder.processEncoderStreamData(
            impliedCapacityInstruction(corpusCase.tableSize)
        );

        const decodes: Array<Promise<[number, HeaderField[]]>> = [];
        for (const block of blocks) {
            if (block.streamId === ENCODER_STREAM_ID) {
                // Instructions split across arbitrary chunk boundaries:
                for (const byte of block.data) {
                    decoder.processEncoderStreamData(Uint8Array.from([byte]));
                }
            } else {
                const decode = decoder.decodeFieldSection(block.streamId, block.data)
                    .then((headers): [number, HeaderField[]] => [block.streamId, headers]);
                decode.catch(() => {});
                decodes.push(decode);
            }
        }

        const decoded = new Map(await Promise.all(decodes));
        const expected = await readReferenceDecoding(corpusCase);
        expect(sortedBlockEntries(decoded)).to.deep.equal(sortedBlockEntries(expected));
    });

});
