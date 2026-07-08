import { expect } from 'chai';

import { QpackEncoder, QpackDecoder, type HeaderField } from '../src/index.js';
import { qit, withTimeout } from './harness/disabled.js';
import { QIF_NAMES, readQif } from './harness/corpus.js';
import { parseQif } from './harness/qif.js';

const TABLE_SIZES = [0, 256, 4096];
const MAX_BLOCKED = [0, 100];
const ACK_MODES = [0, 1];

const qifBlocks = new Map<string, HeaderField[][]>();
for (const name of QIF_NAMES) {
    qifBlocks.set(name, parseQif(await readQif(`qifs/${name}.qif`)));
}

/**
 * Encodes every corpus QIF with our encoder and decodes it with our decoder,
 * across the full settings matrix, feeding decoder stream output back to the
 * encoder when acknowledgments are enabled.
 */
describe('round trip', function () {
    this.timeout(30000);

    const roundTrip = async (
        blocks: HeaderField[][],
        options: {
            tableSize: number,
            maxBlocked: number,
            ackMode: number,
            useHuffman?: boolean
        }
    ) => {
        const encoder = new QpackEncoder({
            maxTableCapacity: options.tableSize,
            maxBlockedStreams: options.maxBlocked,
            useHuffman: options.useHuffman
        });
        const decoder = new QpackDecoder({
            maxTableCapacity: options.tableSize,
            maxBlockedStreams: options.maxBlocked
        });

        for (let i = 0; i < blocks.length; i++) {
            const headers = blocks[i]!;
            const streamId = i + 1;

            const { fieldSection, encoderStreamData } =
                encoder.encodeFieldSection(streamId, headers);
            if (encoderStreamData.length > 0) {
                decoder.processEncoderStreamData(encoderStreamData);
            }

            const decoded = await withTimeout(
                decoder.decodeFieldSection(streamId, fieldSection)
            );
            expect(decoded, `header block ${i}`).to.deep.equal(headers);

            if (options.ackMode === 1) {
                const feedback = decoder.takeDecoderStreamData();
                if (feedback.length > 0) encoder.processDecoderStreamData(feedback);
            }
        }
    };

    for (const [name, blocks] of qifBlocks) {
        for (const tableSize of TABLE_SIZES) {
            for (const maxBlocked of MAX_BLOCKED) {
                for (const ackMode of ACK_MODES) {
                    qit(
                        `${name} (table ${tableSize}, blocked ${maxBlocked}, ack ${ackMode})`,
                        () => roundTrip(blocks, { tableSize, maxBlocked, ackMode })
                    );
                }
            }
        }

        qit(`${name} (table 4096, blocked 100, ack 1, no huffman)`, () =>
            roundTrip(blocks, {
                tableSize: 4096,
                maxBlocked: 100,
                ackMode: 1,
                useHuffman: false
            })
        );
    }

});
