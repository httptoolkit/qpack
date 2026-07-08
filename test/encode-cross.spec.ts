import { expect } from 'chai';

import { QpackEncoder, type HeaderField } from '../src/index.js';

import { QIF_NAMES, readQif } from './harness/corpus.js';
import { parseQif, decodedBlocksInStreamOrder } from './harness/qif.js';
import { writeInteropBlocks, type InteropBlock, ENCODER_STREAM_ID } from './harness/framing.js';
import { lsqpackDecode } from './harness/lsqpack.js';

const TABLE_SIZES = [0, 256, 4096];
const MAX_BLOCKED = [0, 100];

const qifBlocks = new Map<string, HeaderField[][]>();
for (const name of QIF_NAMES) {
    qifBlocks.set(name, parseQif(await readQif(`qifs/${name}.qif`)));
}

/**
 * Encodes every corpus QIF with our encoder, then has ls-qpack's reference
 * decoder decode the result and checks it gets the original input back.
 * There is no acknowledgment channel here (the reference decoder is offline),
 * so this exercises unacknowledged encoding only.
 */
describe('encode cross-check', function () {
    this.timeout(30000);

    for (const [name, blocks] of qifBlocks) {
        for (const tableSize of TABLE_SIZES) {
            for (const maxBlocked of MAX_BLOCKED) {
                it(`${name} (table ${tableSize}, blocked ${maxBlocked})`, async () => {
                    const encoder = new QpackEncoder({
                        maxTableCapacity: tableSize,
                        maxBlockedStreams: maxBlocked
                    });

                    const interopBlocks: InteropBlock[] = [];
                    for (let i = 0; i < blocks.length; i++) {
                        const { fieldSection, encoderStreamData } =
                            encoder.encodeFieldSection(i + 1, blocks[i]!);
                        if (encoderStreamData.length > 0) {
                            interopBlocks.push({
                                streamId: ENCODER_STREAM_ID,
                                data: encoderStreamData
                            });
                        }
                        interopBlocks.push({ streamId: i + 1, data: fieldSection });
                    }

                    const decoded = await lsqpackDecode(
                        writeInteropBlocks(interopBlocks),
                        { tableSize, maxBlocked }
                    );
                    expect(decodedBlocksInStreamOrder(decoded)).to.deep.equal(blocks);
                });
            }
        }
    }

});
