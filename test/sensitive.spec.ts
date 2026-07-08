import { expect } from 'chai';

import { QpackEncoder, QpackDecoder, type HeaderField } from '../src/index.js';
import { writeInteropBlocks, ENCODER_STREAM_ID, type InteropBlock } from './harness/framing.js';
import { lsqpackDecode } from './harness/lsqpack.js';
import { nghttp3Decode } from './harness/nghttp3.js';
import { hex, utf8, withTimeout } from './harness/utils.js';
import { concatBytes } from '../src/strings.js';

const SETTINGS = { maxTableCapacity: 4096, maxBlockedStreams: 100 };

describe('sensitive fields', () => {

    describe('encoding', () => {
        it('uses a never-indexed literal with a static name reference', () => {
            const encoder = new QpackEncoder({ useHuffman: false });
            const { fieldSection } = encoder.encodeFieldSection(1, [
                { name: ':path', value: '/index.html', sensitive: true }
            ]);

            // As RFC 9204 B.1, but with the N bit set (0x71 rather than 0x51):
            expect(fieldSection).to.deep.equal(concatBytes([
                hex('0000 710b'),
                utf8('/index.html')
            ]));
        });

        it('uses a never-indexed literal for unknown names', () => {
            const encoder = new QpackEncoder({ useHuffman: false });
            const { fieldSection } = encoder.encodeFieldSection(1, [
                { name: 'x-secret', value: 'v', sensitive: true }
            ]);

            expect(fieldSection).to.deep.equal(concatBytes([
                hex('0000 3701'), // 001 N=1 H=0, name length 7+1
                utf8('x-secret'),
                hex('01'),
                utf8('v')
            ]));
        });

        it('never inserts sensitive fields into the dynamic table', () => {
            const sensitiveField = {
                name: 'x-secret-token', value: 'abc123', sensitive: true
            };
            const encoder = new QpackEncoder(SETTINGS);
            const decoder = new QpackDecoder(SETTINGS);

            const sections = [];
            for (let i = 1; i <= 5; i++) {
                const { fieldSection, encoderStreamData } =
                    encoder.encodeFieldSection(i, [sensitiveField]);
                sections.push(fieldSection);

                if (i === 1) {
                    // Only the Set Dynamic Table Capacity instruction - no
                    // insertions, ever:
                    expect(encoderStreamData).to.deep.equal(hex('3f e1 1f'));
                    decoder.processEncoderStreamData(encoderStreamData);
                } else {
                    expect(encoderStreamData.length).to.equal(0);
                }

                // Required Insert Count 0: no dynamic table references:
                expect(fieldSection[0]).to.equal(0);
                const feedback = decoder.takeDecoderStreamData();
                if (feedback.length > 0) encoder.processDecoderStreamData(feedback);
            }

            // While an identical field without the flag does get indexed:
            const control = new QpackEncoder(SETTINGS);
            control.encodeFieldSection(1, [{ name: 'x-secret-token', value: 'abc123' }]);
            const second = control.encodeFieldSection(2, [
                { name: 'x-secret-token', value: 'abc123' }
            ]);
            expect(second.encoderStreamData.length).to.be.greaterThan(0);
            expect(second.fieldSection[0]).to.not.equal(0);
        });

        it('does not index sensitive fields even when the value is in the table', async () => {
            const encoder = new QpackEncoder(SETTINGS);
            const decoder = new QpackDecoder(SETTINGS);

            // Get the value into the dynamic table via non-sensitive uses:
            const plainField = { name: 'x-token', value: 'zzz' };
            for (let i = 1; i <= 2; i++) {
                const { fieldSection, encoderStreamData } =
                    encoder.encodeFieldSection(i, [plainField]);
                if (encoderStreamData.length > 0) {
                    decoder.processEncoderStreamData(encoderStreamData);
                }
                await withTimeout(decoder.decodeFieldSection(i, fieldSection));
                const feedback = decoder.takeDecoderStreamData();
                if (feedback.length > 0) encoder.processDecoderStreamData(feedback);
            }

            const { fieldSection, encoderStreamData } = encoder.encodeFieldSection(3, [
                { name: 'x-token', value: 'zzz', sensitive: true }
            ]);
            // No insertion, and the value comes back never-indexed (it may
            // use a dynamic name reference - names are safe to reference):
            expect(encoderStreamData.length).to.equal(0, 'no insertions');
            expect(await withTimeout(decoder.decodeFieldSection(3, fieldSection)))
                .to.deep.equal([{ name: 'x-token', value: 'zzz', sensitive: true }]);
        });
    });

    describe('decoding', () => {
        it('exposes the N bit on name-reference literals', async () => {
            const decoder = new QpackDecoder();
            expect(await withTimeout(decoder.decodeFieldSection(0, concatBytes([
                hex('0000 710b'), utf8('/index.html')
            ])))).to.deep.equal([
                { name: ':path', value: '/index.html', sensitive: true }
            ]);
        });

        it('exposes the N bit on literal-name field lines', async () => {
            const decoder = new QpackDecoder();
            expect(await withTimeout(decoder.decodeFieldSection(0, concatBytes([
                hex('0000 3701'), utf8('x-secret'), hex('01'), utf8('v')
            ])))).to.deep.equal([
                { name: 'x-secret', value: 'v', sensitive: true }
            ]);
        });

        it('exposes the N bit on dynamic-name and post-base literals', async () => {
            const setUp = () => {
                const decoder = new QpackDecoder(SETTINGS);
                decoder.processEncoderStreamData(concatBytes([
                    hex('3fe11f'), // Set capacity 4096
                    hex('48'), utf8('x-secret'), // Insert with literal name...
                    hex('05'), utf8('first')     // ...= x-secret: first
                ]));
                decoder.takeDecoderStreamData();
                return decoder;
            };

            // Literal with dynamic name reference (N=1), Base 1:
            expect(await withTimeout(setUp().decodeFieldSection(0, concatBytes([
                hex('0200 60 02'), utf8('v2')
            ])))).to.deep.equal([
                { name: 'x-secret', value: 'v2', sensitive: true }
            ]);

            // Literal with post-base name reference (N=1), Base 0:
            expect(await withTimeout(setUp().decodeFieldSection(0, concatBytes([
                hex('0280 08 02'), utf8('v3')
            ])))).to.deep.equal([
                { name: 'x-secret', value: 'v3', sensitive: true }
            ]);
        });

        it('omits the flag entirely for ordinary fields', async () => {
            const decoder = new QpackDecoder();
            const headers = await withTimeout(decoder.decodeFieldSection(0, concatBytes([
                hex('0000 510b'), utf8('/index.html')
            ])));
            expect(headers).to.deep.equal([{ name: ':path', value: '/index.html' }]);
            expect('sensitive' in headers[0]!).to.equal(false);
        });
    });

    describe('as an intermediary', () => {
        it('preserves never-indexed status through decode and re-encode', async () => {
            // Receive fields marked sensitive by some other implementation:
            const receiveDecoder = new QpackDecoder();
            const received = await withTimeout(receiveDecoder.decodeFieldSection(
                0,
                concatBytes([
                    hex('0000 710b'), utf8('/index.html'),
                    hex('3701'), utf8('x-secret'), hex('01'), utf8('v'),
                    hex('51 04'), utf8('/img') // An ordinary field alongside
                ])
            ));

            // Forward them through our encoder, unchanged:
            const forwardEncoder = new QpackEncoder(SETTINGS);
            const forwardDecoder = new QpackDecoder(SETTINGS);
            const { fieldSection, encoderStreamData } =
                forwardEncoder.encodeFieldSection(1, received);
            if (encoderStreamData.length > 0) {
                forwardDecoder.processEncoderStreamData(encoderStreamData);
            }

            const forwarded = await withTimeout(
                forwardDecoder.decodeFieldSection(1, fieldSection));
            expect(forwarded).to.deep.equal([
                { name: ':path', value: '/index.html', sensitive: true },
                { name: 'x-secret', value: 'v', sensitive: true },
                { name: ':path', value: '/img' }
            ]);
        });

        it('mutating decoded headers cannot corrupt the tables', async () => {
            const decoder = new QpackDecoder(SETTINGS);
            decoder.processEncoderStreamData(concatBytes([
                hex('3fe11f'),
                hex('48'), utf8('x-secret'), hex('05'), utf8('first')
            ]));

            // Decode the same static & dynamic entries twice, mutating the
            // first results in between:
            const section = hex('0200 c1 80'); // static :path, dynamic x-secret
            const first = await withTimeout(decoder.decodeFieldSection(0, section));
            first[0]!.sensitive = true;
            first[0]!.value = 'corrupted';
            first[1]!.value = 'corrupted';

            const second = await withTimeout(decoder.decodeFieldSection(4, section));
            expect(second).to.deep.equal([
                { name: ':path', value: '/' },
                { name: 'x-secret', value: 'first' }
            ]);
        });
    });

    it('produces output the reference implementations decode correctly', async () => {
        const headers: HeaderField[] = [
            { name: ':method', value: 'GET' },
            { name: 'authorization', value: 'Bearer abc123', sensitive: true },
            { name: 'cookie', value: 'session=xyz', sensitive: true },
            { name: 'x-plain', value: 'ordinary' }
        ];

        const encoder = new QpackEncoder(SETTINGS);
        const interopBlocks: InteropBlock[] = [];
        for (let i = 1; i <= 3; i++) {
            const { fieldSection, encoderStreamData } =
                encoder.encodeFieldSection(i, headers);
            if (encoderStreamData.length > 0) {
                interopBlocks.push({ streamId: ENCODER_STREAM_ID, data: encoderStreamData });
            }
            interopBlocks.push({ streamId: i, data: fieldSection });
        }

        const interopFile = writeInteropBlocks(interopBlocks);
        const plainHeaders = headers.map(({ name, value }) => ({ name, value }));
        const settings = { tableSize: 4096, maxBlocked: 100 };

        const lsqpack = await lsqpackDecode(interopFile, settings);
        expect([...lsqpack.values()]).to.deep.equal(
            [plainHeaders, plainHeaders, plainHeaders], 'ls-qpack');

        expect(await nghttp3Decode(interopFile, settings)).to.deep.equal(
            [plainHeaders, plainHeaders, plainHeaders], 'nghttp3');
    });

});
