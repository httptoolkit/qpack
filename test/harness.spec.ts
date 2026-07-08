import { expect } from 'chai';

import { parseQif, serializeQif, decodedBlocksInStreamOrder } from './harness/qif.js';
import { readInteropBlocks, writeInteropBlocks, ENCODER_STREAM_ID } from './harness/framing.js';
import { lsqpackDecode, lsqpackEncode } from './harness/lsqpack.js';
import { nghttp3Decode, nghttp3Encode } from './harness/nghttp3.js';
import { loadCorpusManifest, readCorpusFile, readQif, readReferenceDecoding, QIF_NAMES } from './harness/corpus.js';
import { sortedBlockEntries, hex } from './harness/utils.js';

/**
 * Self-tests for the verification harness itself. These don't touch our
 * QPACK implementation at all, and must always pass.
 */
describe('test harness', function () {
    this.timeout(30000);

    describe('qif handling', () => {
        it('parses basic QIF content', () => {
            const blocks = parseQif(
                '# A comment\n' +
                ':method\tGET\n' +
                ':path\t/\n' +
                'empty-value\t\n' +
                '\n' +
                ':method\tPOST\n'
            );
            expect(blocks).to.deep.equal([
                [
                    { name: ':method', value: 'GET' },
                    { name: ':path', value: '/' },
                    { name: 'empty-value', value: '' }
                ],
                [{ name: ':method', value: 'POST' }]
            ]);
        });

        it('round-trips every corpus QIF through serialization', async () => {
            for (const name of QIF_NAMES) {
                const text = await readQif(`qifs/${name}.qif`);
                const blocks = parseQif(text);
                expect(blocks.length, name).to.be.greaterThan(0);
                expect(parseQif(serializeQif(blocks)), name).to.deep.equal(blocks);
            }
        });
    });

    describe('interop framing', () => {
        it('round-trips a corpus encoded file byte-for-byte', async () => {
            const encoded = await readCorpusFile(
                'encoded/qpack-06/ls-qpack/fb-req.out.4096.100.1'
            );
            const blocks = readInteropBlocks(encoded);

            expect(blocks.length).to.be.greaterThan(1);
            expect(blocks.some((b) => b.streamId === ENCODER_STREAM_ID)).to.equal(true);
            expect(blocks.some((b) => b.streamId !== ENCODER_STREAM_ID)).to.equal(true);

            expect(writeInteropBlocks(blocks)).to.deep.equal(new Uint8Array(encoded));
        });

        it('rejects truncated data', () => {
            expect(() => readInteropBlocks(hex('00 00 00 00'))).to.throw('Truncated');
            expect(() => readInteropBlocks(
                hex('00 00 00 00 00 00 00 01 00 00 00 02 ff')
            )).to.throw('Truncated');
        });
    });

    describe('ls-qpack reference implementation', () => {
        it('decodes a corpus file back to its source QIF', async () => {
            const encoded = await readCorpusFile(
                'encoded/qpack-06/nghttp3/fb-req.out.4096.100.1'
            );
            const decoded = await lsqpackDecode(encoded, {
                tableSize: 4096,
                maxBlocked: 100
            });

            const expected = parseQif(await readQif('qifs/fb-req.qif'));
            expect(decodedBlocksInStreamOrder(decoded)).to.deep.equal(expected);
        });

        it('round-trips fresh encodings through encode and decode', async () => {
            const blocks = parseQif(await readQif('qifs/fb-req.qif')).slice(0, 20);
            const qifText = serializeQif(blocks);

            for (const settings of [
                { tableSize: 0, maxBlocked: 0, ackMode: 0 as const },
                { tableSize: 4096, maxBlocked: 100, ackMode: 1 as const }
            ]) {
                const encoded = await lsqpackEncode(qifText, settings);
                const decoded = await lsqpackDecode(encoded, settings);
                expect(decodedBlocksInStreamOrder(decoded), JSON.stringify(settings))
                    .to.deep.equal(blocks);
            }
        });

        it('rejects invalid input', async () => {
            const invalid = writeInteropBlocks([
                { streamId: 1, data: hex('ff') } // Truncated field section prefix
            ]);
            let error: Error | null = null;
            await lsqpackDecode(invalid, { tableSize: 4096, maxBlocked: 100 })
                .catch((e) => { error = e; });
            expect(error).to.be.an.instanceOf(Error);
        });
    });

    describe('nghttp3 reference implementation', () => {
        it('decodes a corpus file back to its source QIF', async () => {
            const encoded = await readCorpusFile(
                'encoded/qpack-06/ls-qpack/fb-req.out.4096.100.1'
            );
            const decoded = await nghttp3Decode(encoded, {
                tableSize: 4096,
                maxBlocked: 100
            });

            const expected = parseQif(await readQif('qifs/fb-req.qif'));
            expect(decoded).to.deep.equal(expected);
        });

        it('round-trips fresh encodings through encode and decode', async () => {
            const blocks = parseQif(await readQif('qifs/fb-req.qif')).slice(0, 20);
            const qifText = serializeQif(blocks);

            for (const settings of [
                { tableSize: 0, maxBlocked: 0, ackMode: 0 as const },
                { tableSize: 4096, maxBlocked: 100, ackMode: 1 as const }
            ]) {
                const encoded = await nghttp3Encode(qifText, settings);
                const decoded = await nghttp3Decode(encoded, settings);
                expect(decoded, JSON.stringify(settings)).to.deep.equal(blocks);
            }
        });
    });

    describe('corpus manifest', () => {
        it('covers the entire corpus with no unexplained exclusions', async () => {
            const manifest = await loadCorpusManifest();

            expect(manifest.cases.length).to.equal(530);

            // Every corpus file is expected to be decodable by the reference
            // implementation. If a corpus update breaks this, the exclusion
            // needs reviewing and documenting explicitly here.
            const excluded = manifest.cases.filter((c) => !c.referenceOk);
            expect(excluded.map((c) => `${c.id}: ${c.note}`)).to.deep.equal([]);

            // Implementation variety - at least 5 independent encoders:
            const impls = new Set(manifest.cases.map((c) => c.id.split('/')[1]));
            expect(impls.size).to.be.greaterThanOrEqual(5);

            // And nghttp3 independently agrees with every ls-qpack decoding:
            const disagreements = manifest.cases.filter((c) => !c.nghttp3Ok);
            expect(disagreements.map((c) => `${c.id}: ${c.nghttp3Note}`))
                .to.deep.equal([]);
        });

        it('provides parseable reference decodings', async () => {
            const manifest = await loadCorpusManifest();
            const testCase = manifest.cases.find(
                (c) => c.id === 'qpack-06/quinn/fb-resp.out.256.100.0'
            )!;
            expect(testCase).to.not.equal(undefined);

            const decoded = await readReferenceDecoding(testCase);
            expect(sortedBlockEntries(decoded).length).to.be.greaterThan(0);

            const expected = parseQif(await readQif(testCase.qifPath!));
            expect(decodedBlocksInStreamOrder(decoded)).to.deep.equal(expected);
        });

        it('records which error-corpus files the reference rejects', async () => {
            const manifest = await loadCorpusManifest();

            expect(manifest.errorCases.length).to.equal(12);

            // The reference decoder accepts err9 and err10: they are
            // draft-era fixtures (indexed static entries 0 and 62, invalid
            // against the smaller draft-05 static table) that are valid
            // field sections under RFC 9204's 99-entry table:
            const accepted = manifest.errorCases
                .filter((c) => !c.rejectedByReference)
                .map((c) => c.id)
                .sort();
            expect(accepted).to.deep.equal(['errors/err10', 'errors/err9']);
        });
    });

});
