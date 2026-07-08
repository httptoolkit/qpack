import { expect } from 'chai';

import { QpackDecoder, type HeaderField } from '../src/index.js';
import { QIF_NAMES, readQif } from './harness/corpus.js';
import { parseQif } from './harness/qif.js';
import {
    readInteropBlocks,
    impliedCapacityInstruction,
    ENCODER_STREAM_ID
} from './harness/framing.js';
import { lsqpackEncode, type InteropEncodeSettings } from './harness/lsqpack.js';
import { nghttp3Encode } from './harness/nghttp3.js';
import { sortedBlockEntries, withTimeout } from './harness/utils.js';

const TABLE_SIZES = [0, 256, 4096];
const MAX_BLOCKED = [0, 100];
const ACK_MODES = [0, 1] as const;

const qifTexts = new Map<string, string>();
const qifBlocks = new Map<string, HeaderField[][]>();
for (const name of QIF_NAMES) {
    const text = await readQif(`qifs/${name}.qif`);
    qifTexts.set(name, text);
    qifBlocks.set(name, parseQif(text));
}

/**
 * Encodes every corpus QIF freshly with ls-qpack's and nghttp3's reference
 * encoders (which, unlike the static corpus, are certainly current RFC 9204
 * output) and checks our decoder decodes it all back to the original input.
 */
describe('decode cross-check', function () {
    this.timeout(30000);

    const decodeCrossCheck = async (
        name: string,
        encoded: Uint8Array,
        settings: { tableSize: number, maxBlocked: number },
        implyCapacity: boolean
    ) => {
        const interopBlocks = readInteropBlocks(encoded);

        const decoder = new QpackDecoder({
            maxTableCapacity: settings.tableSize,
            maxBlockedStreams: settings.maxBlocked
        });
        if (implyCapacity) {
            decoder.processEncoderStreamData(
                impliedCapacityInstruction(settings.tableSize)
            );
        }

        const decodes: Array<Promise<[number, HeaderField[]]>> = [];
        for (const block of interopBlocks) {
            if (block.streamId === ENCODER_STREAM_ID) {
                decoder.processEncoderStreamData(block.data);
            } else {
                const decode = decoder.decodeFieldSection(block.streamId, block.data)
                    .then((headers): [number, HeaderField[]] => [block.streamId, headers]);
                decode.catch(() => {});
                decodes.push(decode);
            }
        }

        const decoded = new Map(await withTimeout(Promise.all(decodes), 5000));

        // The reference encoders assign stream IDs 1..n to the QIF's blocks
        // in order:
        const expected = qifBlocks.get(name)!;
        const decodedInOrder = sortedBlockEntries(decoded).map(([, headers]) => headers);
        expect(decodedInOrder).to.deep.equal(expected);
    };

    // ls-qpack relies on the interop format's implied table capacity;
    // nghttp3 sends a real Set Dynamic Table Capacity instruction, so its
    // output also exercises the pure RFC flow with no implied setup:

    const lsqpackCrossCheck = async (name: string, settings: InteropEncodeSettings) =>
        decodeCrossCheck(
            name,
            await lsqpackEncode(qifTexts.get(name)!, settings),
            settings,
            true
        );

    const nghttp3CrossCheck = async (
        name: string,
        settings: { tableSize: number, maxBlocked: number, ackMode: 0 | 1 }
    ) =>
        decodeCrossCheck(
            name,
            await nghttp3Encode(qifTexts.get(name)!, settings),
            settings,
            false
        );

    for (const name of QIF_NAMES) {
        for (const tableSize of TABLE_SIZES) {
            for (const maxBlocked of MAX_BLOCKED) {
                for (const ackMode of ACK_MODES) {
                    it(
                        `${name} (table ${tableSize}, blocked ${maxBlocked}, ack ${ackMode})`,
                        () => lsqpackCrossCheck(name, { tableSize, maxBlocked, ackMode })
                    );
                    it(
                        `${name} via nghttp3 (table ${tableSize}, blocked ${maxBlocked}, ` +
                        `ack ${ackMode})`,
                        () => nghttp3CrossCheck(name, { tableSize, maxBlocked, ackMode })
                    );
                }
            }
        }

        it(`${name} (table 4096, blocked 100, ack 1, aggressive)`, () =>
            lsqpackCrossCheck(name, {
                tableSize: 4096,
                maxBlocked: 100,
                ackMode: 1,
                aggressive: true
            })
        );
    }

});
