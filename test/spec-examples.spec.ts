import { expect } from 'chai';

import { QpackDecoder } from '../src/index.js';
import { qit, withTimeout } from './harness/disabled.js';
import { hex, expectRejection } from './harness/utils.js';

/**
 * The worked examples from RFC 9204 appendix B, used as byte-exact decoder
 * vectors: we feed in the example's encoder stream and field section bytes,
 * and check the decoded output and the decoder stream instructions we emit.
 *
 * Decoded headers and the emitted Section Acknowledgments and Stream
 * Cancellations are RFC requirements. Insert Count Increments are a policy
 * choice (the RFC allows deciding when, if ever, to send them): this
 * implementation emits an increment whenever processing encoder stream data
 * increases the insert count, so unlike the example's trace, an increment
 * is also expected before the B.2 section acknowledgment.
 */
describe('RFC 9204 appendix B', () => {

    const B2_ENCODER_INSTRUCTIONS = hex(`
        3fbd01
        c00f 7777 772e 6578 616d 706c 652e 636f 6d
        c10c 2f73 616d 706c 652f 7061 7468
    `);
    const B2_FIELD_SECTION = hex('0381 10 11');
    const B3_ENCODER_INSTRUCTIONS = hex(`
        4a63 7573 746f 6d2d 6b65 790c 6375 7374 6f6d 2d76 616c 7565
    `);
    const B4_ENCODER_INSTRUCTIONS = hex('02');
    const B4_FIELD_SECTION = hex('0500 80 c1 81');
    const B5_ENCODER_INSTRUCTIONS = hex('810d 6375 7374 6f6d 2d76 616c 7565 32');

    // The examples use a 220-byte dynamic table and permit blocked streams:
    const newDecoder = () => new QpackDecoder({
        maxTableCapacity: 220,
        maxBlockedStreams: 100
    });

    const setUpThroughB3 = () => {
        const decoder = newDecoder();
        decoder.processEncoderStreamData(B2_ENCODER_INSTRUCTIONS);
        decoder.processEncoderStreamData(B3_ENCODER_INSTRUCTIONS);
        decoder.takeDecoderStreamData();
        return decoder;
    };

    qit('B.1 literal field line with name reference', async () => {
        const decoder = new QpackDecoder();
        const headers = await withTimeout(decoder.decodeFieldSection(
            0,
            hex('0000 510b 2f69 6e64 6578 2e68 746d 6c')
        ));
        expect(headers).to.deep.equal([
            { name: ':path', value: '/index.html' }
        ]);

        // Required Insert Count is 0, so no acknowledgment is emitted:
        expect(decoder.takeDecoderStreamData()).to.deep.equal(new Uint8Array(0));
    });

    qit('B.2 dynamic table insertions and a referencing field section', async () => {
        const decoder = newDecoder();
        decoder.processEncoderStreamData(B2_ENCODER_INSTRUCTIONS);

        // Insert Count Increment (2), by this implementation's eager policy:
        expect(decoder.takeDecoderStreamData()).to.deep.equal(hex('02'));

        const headers = await withTimeout(
            decoder.decodeFieldSection(4, B2_FIELD_SECTION)
        );
        expect(headers).to.deep.equal([
            { name: ':authority', value: 'www.example.com' },
            { name: ':path', value: '/sample/path' }
        ]);

        // Section Acknowledgment for stream 4 (required by RFC 9204 s4.4.1):
        expect(decoder.takeDecoderStreamData()).to.deep.equal(hex('84'));
    });

    qit('B.2 field section blocks until its insertions arrive', async () => {
        const decoder = newDecoder();

        let decoded = false;
        const decodePromise = decoder.decodeFieldSection(4, B2_FIELD_SECTION)
            .then((headers) => { decoded = true; return headers; });

        await new Promise((resolve) => setImmediate(resolve));
        expect(decoded).to.equal(false, 'should block until the insertions arrive');

        decoder.processEncoderStreamData(B2_ENCODER_INSTRUCTIONS);
        const headers = await withTimeout(decodePromise);
        expect(headers).to.deep.equal([
            { name: ':authority', value: 'www.example.com' },
            { name: ':path', value: '/sample/path' }
        ]);
    });

    qit('B.3 speculative insert with a literal name', () => {
        const decoder = newDecoder();
        decoder.processEncoderStreamData(B2_ENCODER_INSTRUCTIONS);
        decoder.takeDecoderStreamData();

        decoder.processEncoderStreamData(B3_ENCODER_INSTRUCTIONS);

        // Insert Count Increment (1):
        expect(decoder.takeDecoderStreamData()).to.deep.equal(hex('01'));
    });

    qit('B.4 duplicate instruction and field section', async () => {
        const decoder = setUpThroughB3();

        decoder.processEncoderStreamData(B4_ENCODER_INSTRUCTIONS);
        expect(decoder.takeDecoderStreamData()).to.deep.equal(hex('01'));

        const headers = await withTimeout(
            decoder.decodeFieldSection(8, B4_FIELD_SECTION)
        );
        expect(headers).to.deep.equal([
            { name: ':authority', value: 'www.example.com' },
            { name: ':path', value: '/' },
            { name: 'custom-key', value: 'custom-value' }
        ]);

        // Section Acknowledgment for stream 8:
        expect(decoder.takeDecoderStreamData()).to.deep.equal(hex('88'));
    });

    qit('B.4 stream cancellation while blocked', async () => {
        const decoder = setUpThroughB3();

        // The encoder stream data with the Duplicate instruction is delayed,
        // so the field section (Required Insert Count = 4) blocks:
        const decodePromise = decoder.decodeFieldSection(8, B4_FIELD_SECTION);
        decodePromise.catch(() => {}); // Rejection is checked below

        await new Promise((resolve) => setImmediate(resolve));

        decoder.cancelStream(8);

        // Stream Cancellation for stream 8:
        expect(decoder.takeDecoderStreamData()).to.deep.equal(hex('48'));
        await expectRejection(withTimeout(decodePromise));

        // The delayed Duplicate instruction still applies when it arrives:
        decoder.processEncoderStreamData(B4_ENCODER_INSTRUCTIONS);
        expect(decoder.takeDecoderStreamData()).to.deep.equal(hex('01'));
    });

    qit('B.5 insert with dynamic name reference, evicting an entry', async () => {
        const decoder = setUpThroughB3();
        decoder.processEncoderStreamData(B4_ENCODER_INSTRUCTIONS);
        decoder.takeDecoderStreamData();

        // Inserts custom-key=custom-value2 (abs index 4), evicting abs index 0:
        decoder.processEncoderStreamData(B5_ENCODER_INSTRUCTIONS);
        expect(decoder.takeDecoderStreamData()).to.deep.equal(hex('01'));

        // The new entry is usable: Required Insert Count = 5, Base = 5,
        // then an indexed field line for relative index 0 (abs index 4):
        const headers = await withTimeout(decoder.decodeFieldSection(12, hex('0600 80')));
        expect(headers).to.deep.equal([
            { name: 'custom-key', value: 'custom-value2' }
        ]);
        expect(decoder.takeDecoderStreamData()).to.deep.equal(hex('8c')); // Ack, stream 12
    });

    qit('B.5 references to evicted entries are rejected', async () => {
        const decoder = setUpThroughB3();
        decoder.processEncoderStreamData(B4_ENCODER_INSTRUCTIONS);
        decoder.processEncoderStreamData(B5_ENCODER_INSTRUCTIONS);

        // Required Insert Count = 1, Base = 1, indexed field line for
        // relative index 0 = abs index 0, which has been evicted:
        const error = await expectRejection(
            withTimeout(decoder.decodeFieldSection(16, hex('0200 80')))
        );
        expect(error).to.have.property('name', 'QpackError');
    });

});
