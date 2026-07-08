import { expect } from 'chai';

import {
    QpackEncoder,
    QpackDecoder,
    FieldSectionTooLargeError,
    type HeaderField
} from '../src/index.js';
import { QIF_NAMES, readQif } from './harness/corpus.js';
import { parseQif, decodedBlocksInStreamOrder } from './harness/qif.js';
import { writeInteropBlocks, type InteropBlock, ENCODER_STREAM_ID } from './harness/framing.js';
import { lsqpackDecode } from './harness/lsqpack.js';
import { nghttp3Decode } from './harness/nghttp3.js';
import { withTimeout } from './harness/utils.js';

const fbReqBlocks = parseQif(await readQif(`qifs/${QIF_NAMES[0]}.qif`)).slice(0, 40);

/** Encodes blocks, feeding all decoder feedback straight back */
const encodeAll = (
    encoder: QpackEncoder,
    decoder: QpackDecoder,
    blocks: HeaderField[][],
    firstStreamId = 1
) => {
    const interopBlocks: InteropBlock[] = [];
    const decoded: Promise<HeaderField[]>[] = [];
    for (let i = 0; i < blocks.length; i++) {
        const streamId = firstStreamId + i;
        const { fieldSection, encoderStreamData } =
            encoder.encodeFieldSection(streamId, blocks[i]!);
        if (encoderStreamData.length > 0) {
            interopBlocks.push({ streamId: ENCODER_STREAM_ID, data: encoderStreamData });
            decoder.processEncoderStreamData(encoderStreamData);
        }
        interopBlocks.push({ streamId, data: fieldSection });
        decoded.push(decoder.decodeFieldSection(streamId, fieldSection));

        const feedback = decoder.takeDecoderStreamData();
        if (feedback.length > 0) encoder.processDecoderStreamData(feedback);
    }
    return { interopBlocks, decoded };
};

describe('connection lifecycle API', function () {
    this.timeout(30000);

    describe('late peer settings', () => {
        it('starts static-only and enables compression when settings arrive', async () => {
            const encoder = new QpackEncoder(); // No settings known yet
            const decoder = new QpackDecoder({
                maxTableCapacity: 4096,
                maxBlockedStreams: 100
            });

            const beforeSettings = encodeAll(
                encoder, decoder, fbReqBlocks.slice(0, 10));
            expect(
                beforeSettings.interopBlocks
                    .filter((block) => block.streamId === ENCODER_STREAM_ID)
            ).to.deep.equal([], 'no encoder stream data before settings arrive');

            encoder.setPeerSettings({ maxTableCapacity: 4096, maxBlockedStreams: 100 });

            const afterSettings = encodeAll(
                encoder, decoder, fbReqBlocks.slice(10), 11);
            expect(
                afterSettings.interopBlocks
                    .some((block) => block.streamId === ENCODER_STREAM_ID)
            ).to.equal(true, 'dynamic table used once settings arrive');

            // The whole stream decodes correctly - by us and both references:
            const allDecoded = await withTimeout(Promise.all(
                [...beforeSettings.decoded, ...afterSettings.decoded]));
            expect(allDecoded).to.deep.equal(fbReqBlocks);

            const interopFile = writeInteropBlocks([
                ...beforeSettings.interopBlocks,
                ...afterSettings.interopBlocks
            ]);
            const settings = { tableSize: 4096, maxBlocked: 100 };
            expect(decodedBlocksInStreamOrder(await lsqpackDecode(interopFile, settings)))
                .to.deep.equal(fbReqBlocks, 'ls-qpack');
            expect(await nghttp3Decode(interopFile, settings))
                .to.deep.equal(fbReqBlocks, 'nghttp3');
        });

        it('accepts increased limits and ignores omitted ones', () => {
            const encoder = new QpackEncoder({ maxTableCapacity: 1024 });
            encoder.setPeerSettings({ maxBlockedStreams: 50 });
            encoder.setPeerSettings({ maxTableCapacity: 4096 });
            encoder.setPeerSettings({ maxFieldSectionSize: 65536 });
        });

        it('rejects reducing the table capacity below what is in use', () => {
            const encoder = new QpackEncoder({
                maxTableCapacity: 4096,
                maxBlockedStreams: 100
            });
            // Use the dynamic table (first encode emits the capacity):
            encoder.encodeFieldSection(1, [{ name: 'x-custom', value: 'value' }]);

            expect(() => encoder.setPeerSettings({ maxTableCapacity: 1024 }))
                .to.throw(/below the dynamic table capacity already in use/);
        });

        it('rejects reducing blocked streams below the streams at risk', () => {
            const encoder = new QpackEncoder({
                maxTableCapacity: 4096,
                maxBlockedStreams: 100
            });
            // Encode the same headers twice so the second section references
            // an unacknowledged insertion, putting the stream at risk:
            const headers = [{ name: 'x-custom', value: 'value' }];
            encoder.encodeFieldSection(1, headers);
            encoder.encodeFieldSection(2, headers);

            expect(() => encoder.setPeerSettings({ maxBlockedStreams: 0 }))
                .to.throw(/below the number of streams already at risk/);
            encoder.setPeerSettings({ maxBlockedStreams: 100 }); // Unchanged is fine
        });

        it('rejects changing the table capacity once wrapped encodings exist', async () => {
            // At a 256-byte table MaxEntries is 8, so Required Insert Count
            // encodings wrap after 16 insertions:
            const encoder = new QpackEncoder({
                maxTableCapacity: 256,
                maxBlockedStreams: 100
            });
            const decoder = new QpackDecoder({
                maxTableCapacity: 256,
                maxBlockedStreams: 100
            });

            // Distinct headers, each seen twice, to force many insertions:
            const blocks = Array.from({ length: 30 }, (_, i) => [
                { name: 'x-custom', value: `value-${i}` },
                { name: 'x-custom', value: `value-${i}` }
            ]);
            const { decoded } = encodeAll(encoder, decoder, blocks);
            await withTimeout(Promise.all(decoded));

            const insertCount = (encoder as any).table.insertCount as number;
            expect(insertCount).to.be.greaterThanOrEqual(16, 'precondition');

            expect(() => encoder.setPeerSettings({ maxTableCapacity: 512 }))
                .to.throw(/already depend on the previous MaxEntries/);
        });
    });

    describe('max field section size', () => {
        // name (8) + value (5) + 32 overhead = 45 per field:
        const smallField = { name: 'x-custom', value: 'value' };

        it('encoder rejects oversized sections without corrupting state', async () => {
            const encoder = new QpackEncoder({
                maxTableCapacity: 4096,
                maxBlockedStreams: 100,
                maxFieldSectionSize: 100
            });

            expect(() => encoder.encodeFieldSection(1, [smallField, smallField, smallField]))
                .to.throw(FieldSectionTooLargeError);

            // Exactly at the limit is allowed, and the encoder still works:
            const { fieldSection } = encoder.encodeFieldSection(1, [
                smallField,
                { name: 'x-other', value: 'other-value' } // 7 + 11 + 32 = 50
            ]);
            const decoder = new QpackDecoder({ maxTableCapacity: 4096 });
            expect(await withTimeout(decoder.decodeFieldSection(1, fieldSection)))
                .to.deep.equal([smallField, { name: 'x-other', value: 'other-value' }]);
        });

        it('encoder limit can arrive via setPeerSettings', () => {
            const encoder = new QpackEncoder();
            encoder.encodeFieldSection(1, [smallField, smallField, smallField]);

            encoder.setPeerSettings({ maxFieldSectionSize: 100 });
            expect(() => encoder.encodeFieldSection(2, [smallField, smallField, smallField]))
                .to.throw(FieldSectionTooLargeError);
        });

        it('decoder rejects oversized sections', async () => {
            const encoder = new QpackEncoder();
            const { fieldSection } = encoder.encodeFieldSection(
                1,
                [smallField, smallField, smallField]
            );

            const limited = new QpackDecoder({ maxFieldSectionSize: 100 });
            const error = await withTimeout(
                limited.decodeFieldSection(1, fieldSection).then(
                    () => { throw new Error('Decode should have failed'); },
                    (e) => e
                )
            );
            expect(error).to.be.an.instanceOf(FieldSectionTooLargeError);

            // At the limit decodes fine:
            const exact = new QpackDecoder({ maxFieldSectionSize: 135 });
            expect(await withTimeout(exact.decodeFieldSection(1, fieldSection)))
                .to.deep.equal([smallField, smallField, smallField]);
        });

        it('decoder rejects an oversized raw literal from its length alone', async () => {
            const encoder = new QpackEncoder({ useHuffman: false });
            const { fieldSection } = encoder.encodeFieldSection(1, [
                { name: 'x-big', value: 'x'.repeat(200_000) }
            ]);

            const decoder = new QpackDecoder({ maxFieldSectionSize: 1000 });
            const error = await decoder.decodeFieldSection(1, fieldSection)
                .then(() => { throw new Error('Decode should have failed'); }, (e) => e);
            expect(error).to.be.an.instanceOf(FieldSectionTooLargeError);
        });

        it('decoder emits a stream cancellation when abandoning a dynamic section', async () => {
            const encoder = new QpackEncoder({
                maxTableCapacity: 4096,
                maxBlockedStreams: 100
            });
            const decoder = new QpackDecoder({
                maxTableCapacity: 4096,
                maxBlockedStreams: 100,
                maxFieldSectionSize: 100
            });

            // Encode twice so the second section (stream 2) references the
            // dynamic table, then pad it over the size limit:
            const first = encoder.encodeFieldSection(1, [smallField]);
            decoder.processEncoderStreamData(first.encoderStreamData);
            await withTimeout(decoder.decodeFieldSection(1, first.fieldSection));
            encoder.processDecoderStreamData(decoder.takeDecoderStreamData());

            const second = encoder.encodeFieldSection(2, [
                smallField, smallField, smallField
            ]);
            if (second.encoderStreamData.length > 0) {
                decoder.processEncoderStreamData(second.encoderStreamData);
            }
            const error = await withTimeout(
                decoder.decodeFieldSection(2, second.fieldSection).then(
                    () => { throw new Error('Decode should have failed'); },
                    (e) => e
                )
            );
            expect(error).to.be.an.instanceOf(FieldSectionTooLargeError);

            // The decoder stream output ends with Stream Cancellation for
            // stream 2 ('01' + 6-bit stream ID = 0x42):
            const feedback = decoder.takeDecoderStreamData();
            expect(feedback[feedback.length - 1]).to.equal(0x42);
        });
    });

    describe('decoder stream data callback', () => {
        it('delivers the same data that polling would return', async () => {
            const chunks: Uint8Array[] = [];
            const encoder = new QpackEncoder({
                maxTableCapacity: 4096,
                maxBlockedStreams: 100
            });
            const withCallback = new QpackDecoder({
                maxTableCapacity: 4096,
                maxBlockedStreams: 100,
                onDecoderStreamData: (data) => chunks.push(data)
            });
            const polling = new QpackDecoder({
                maxTableCapacity: 4096,
                maxBlockedStreams: 100
            });

            const polled: Uint8Array[] = [];
            for (let i = 0; i < 10; i++) {
                const block = fbReqBlocks[i]!;
                const { fieldSection, encoderStreamData } =
                    encoder.encodeFieldSection(i + 1, block);
                for (const decoder of [withCallback, polling]) {
                    if (encoderStreamData.length > 0) {
                        decoder.processEncoderStreamData(encoderStreamData);
                    }
                    await withTimeout(decoder.decodeFieldSection(i + 1, fieldSection));
                }
                polled.push(polling.takeDecoderStreamData());
                expect(withCallback.takeDecoderStreamData()).to.deep.equal(
                    new Uint8Array(0),
                    'nothing to poll when the callback is consuming'
                );

                const feedback = polled[polled.length - 1]!;
                if (feedback.length > 0) encoder.processDecoderStreamData(feedback);
            }

            expect(Buffer.concat(chunks)).to.deep.equal(Buffer.concat(polled));
            expect(chunks.length).to.be.greaterThan(0);
        });
    });

    describe('encoder stream backpressure', () => {
        it('suspends insertion under backpressure and recovers after', async () => {
            const encoder = new QpackEncoder({
                maxTableCapacity: 4096,
                maxBlockedStreams: 100
            });
            const decoder = new QpackDecoder({
                maxTableCapacity: 4096,
                maxBlockedStreams: 100
            });

            encoder.setEncoderStreamBackpressure(true);
            const blocked = encodeAll(encoder, decoder, fbReqBlocks.slice(0, 10));
            expect(
                blocked.interopBlocks.filter((b) => b.streamId === ENCODER_STREAM_ID)
            ).to.deep.equal([], 'no encoder stream bytes under backpressure');

            encoder.setEncoderStreamBackpressure(false);
            const released = encodeAll(encoder, decoder, fbReqBlocks.slice(10), 11);
            expect(
                released.interopBlocks.some((b) => b.streamId === ENCODER_STREAM_ID)
            ).to.equal(true, 'insertion resumes once backpressure clears');

            const allDecoded = await withTimeout(Promise.all(
                [...blocked.decoded, ...released.decoded]));
            expect(allDecoded).to.deep.equal(fbReqBlocks);

            // And the reference implementations agree end-to-end:
            const interopFile = writeInteropBlocks([
                ...blocked.interopBlocks,
                ...released.interopBlocks
            ]);
            expect(decodedBlocksInStreamOrder(
                await lsqpackDecode(interopFile, { tableSize: 4096, maxBlocked: 100 })
            )).to.deep.equal(fbReqBlocks);
        });
    });

});
