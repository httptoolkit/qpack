import { QpackDecoder, QpackError, type HeaderField } from '../src/index.js';
import { withTimeout } from './harness/utils.js';
import { loadCorpusManifest, readCorpusFile } from './harness/corpus.js';
import {
    readInteropBlocks,
    impliedCapacityInstruction,
    ENCODER_STREAM_ID
} from './harness/framing.js';

const manifest = await loadCorpusManifest();

/**
 * Feeds the corpus's invalid encodings (encoded/errors) to our decoder,
 * which must reject each with a QpackError. Only files that ls-qpack's
 * reference decoder also rejects are tested (see the manifest for the rest).
 */
describe('error corpus', () => {

    for (const errorCase of manifest.errorCases) {
        if (!errorCase.rejectedByReference) continue;

        it(`${errorCase.id} is rejected`, async () => {
            const encoded = await readCorpusFile(errorCase.encodedPath);
            const blocks = readInteropBlocks(encoded);

            const decoder = new QpackDecoder({
                maxTableCapacity: 4096,
                maxBlockedStreams: 100
            });
            decoder.processEncoderStreamData(impliedCapacityInstruction(4096));

            try {
                const decodes: Array<Promise<HeaderField[]>> = [];
                for (const block of blocks) {
                    if (block.streamId === ENCODER_STREAM_ID) {
                        decoder.processEncoderStreamData(block.data);
                    } else {
                        const decode = decoder.decodeFieldSection(block.streamId, block.data);
                        decode.catch(() => {});
                        decodes.push(decode);
                    }
                }
                await withTimeout(Promise.all(decodes));
            } catch (error) {
                if (error instanceof QpackError) return;
                throw new Error(`Rejected with a non-QpackError error: ${error}`);
            }

            throw new Error('Invalid input was decoded without error');
        });
    }

});
