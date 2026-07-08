import { expect } from 'chai';

import { QpackEncoder, QpackDecoder, type HeaderField } from '../src/index.js';
import { withTimeout } from './harness/utils.js';
import { QIF_NAMES, readQif } from './harness/corpus.js';
import { parseQif } from './harness/qif.js';
import { lsqpackEncode } from './harness/lsqpack.js';
import { readInteropBlocks } from './harness/framing.js';

/**
 * Correctness alone doesn't prove the encoder compresses: a static-only
 * encoder decodes fine at any settings. These tests require our total
 * encoded output (field sections plus encoder stream) to be within a small
 * factor of ls-qpack's at the same settings, so real dynamic table usage
 * is load-bearing wherever it should be. At table size 0 we're currently
 * byte-identical to ls-qpack; the factor leaves room for indexing-policy
 * differences once the dynamic table is in play.
 */
const SIZE_FACTOR = 1.15;

const SETTINGS = [
    { tableSize: 0, maxBlocked: 0, ackMode: 0 },
    { tableSize: 256, maxBlocked: 0, ackMode: 1 },
    { tableSize: 256, maxBlocked: 100, ackMode: 0 },
    { tableSize: 256, maxBlocked: 100, ackMode: 1 },
    { tableSize: 4096, maxBlocked: 0, ackMode: 1 },
    { tableSize: 4096, maxBlocked: 100, ackMode: 0 },
    { tableSize: 4096, maxBlocked: 100, ackMode: 1 }
] as const;

const qifTexts = new Map<string, string>();
const qifBlocks = new Map<string, HeaderField[][]>();
for (const name of QIF_NAMES) {
    const text = await readQif(`qifs/${name}.qif`);
    qifTexts.set(name, text);
    qifBlocks.set(name, parseQif(text));
}

describe('compression', function () {
    this.timeout(30000);

    for (const name of QIF_NAMES) {
        for (const { tableSize, maxBlocked, ackMode } of SETTINGS) {
            it(
                `${name} (table ${tableSize}, blocked ${maxBlocked}, ack ${ackMode}) ` +
                `compresses within ${SIZE_FACTOR}x of ls-qpack`,
                async () => {
                    const blocks = qifBlocks.get(name)!;

                    const encoder = new QpackEncoder({
                        maxTableCapacity: tableSize,
                        maxBlockedStreams: maxBlocked
                    });
                    const decoder = new QpackDecoder({
                        maxTableCapacity: tableSize,
                        maxBlockedStreams: maxBlocked
                    });

                    let total = 0;
                    for (let i = 0; i < blocks.length; i++) {
                        const { fieldSection, encoderStreamData } =
                            encoder.encodeFieldSection(i + 1, blocks[i]!);
                        total += fieldSection.length + encoderStreamData.length;

                        if (ackMode === 1) {
                            // Match interop-encode's immediate-ack mode: every
                            // section is decoded and acknowledged before the
                            // next is encoded:
                            if (encoderStreamData.length > 0) {
                                decoder.processEncoderStreamData(encoderStreamData);
                            }
                            await withTimeout(decoder.decodeFieldSection(i + 1, fieldSection));
                            const feedback = decoder.takeDecoderStreamData();
                            if (feedback.length > 0) encoder.processDecoderStreamData(feedback);
                        }
                    }

                    const reference = readInteropBlocks(await lsqpackEncode(
                        qifTexts.get(name)!,
                        { tableSize, maxBlocked, ackMode }
                    )).reduce((sum, block) => sum + block.data.length, 0);

                    expect(total).to.be.at.most(Math.ceil(reference * SIZE_FACTOR));
                }
            );
        }
    }

});
