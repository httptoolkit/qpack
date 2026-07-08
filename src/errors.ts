export type QpackErrorCode =
    | 'QPACK_DECOMPRESSION_FAILED'
    | 'QPACK_ENCODER_STREAM_ERROR'
    | 'QPACK_DECODER_STREAM_ERROR';

// HTTP/3 error code values, for use when closing the connection (RFC 9204 section 6)
export const QPACK_ERROR_CODES: { [K in QpackErrorCode]: number } = {
    QPACK_DECOMPRESSION_FAILED: 0x200,
    QPACK_ENCODER_STREAM_ERROR: 0x201,
    QPACK_DECODER_STREAM_ERROR: 0x202
};

/**
 * A field section exceeding the local (when decoding) or the peer's (when
 * encoding) SETTINGS_MAX_FIELD_SECTION_SIZE limit. Unlike QpackError this
 * is not a connection error: the caller chooses how to handle it (e.g.
 * resetting the stream, or responding with 431).
 */
export class FieldSectionTooLargeError extends Error {
    constructor(
        readonly limit: number,
        message: string
    ) {
        super(message);
        this.name = 'FieldSectionTooLargeError';
    }
}

export class QpackError extends Error {
    constructor(
        readonly code: QpackErrorCode,
        message: string
    ) {
        super(`${code}: ${message}`);
        this.name = 'QpackError';
    }

    get h3ErrorCode(): number {
        return QPACK_ERROR_CODES[this.code];
    }
}
