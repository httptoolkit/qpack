/**
 * The explicit list of known-failing tests, as full-title patterns ('*'
 * matches anything). These tests run on every build but are expected to
 * fail; a disabled test that passes fails the build until it is removed
 * from this list. The implementation is complete when this list is empty.
 */
export const DISABLED_TESTS = [
    // Permanent: a canary test verifying this expected-failure machinery
    // works at all (see harness.spec.ts). Everything below should go.
    'test harness disabled test handling expected-failure canary',

    // Stage 4: decoding with a dynamic table
    'RFC 9204 appendix B B.2 *',
    'RFC 9204 appendix B B.3 *',
    'RFC 9204 appendix B B.4 *',
    'RFC 9204 appendix B B.5 *',
    // The corpus files that actually use the dynamic table. (Not all files
    // at non-zero table sizes do: quinn only uses it when blocked streams
    // are allowed, qthingey when blocked streams or acknowledgments are
    // available, and those files already decode correctly.)
    'corpus decode qpack-06/ls-qpack/*.out.256.*',
    'corpus decode qpack-06/ls-qpack/*.out.512.*',
    'corpus decode qpack-06/ls-qpack/*.out.4096.*',
    'corpus decode qpack-06/nghttp3/*.out.256.*',
    'corpus decode qpack-06/nghttp3/*.out.512.*',
    'corpus decode qpack-06/nghttp3/*.out.4096.*',
    'corpus decode qpack-06/f5/*.out.256.*',
    'corpus decode qpack-06/f5/*.out.512.*',
    'corpus decode qpack-06/f5/*.out.4096.*',
    'corpus decode qpack-06/proxygen/*.out.256.*',
    'corpus decode qpack-06/proxygen/*.out.512.*',
    'corpus decode qpack-06/proxygen/*.out.4096.*',
    'corpus decode qpack-06/quinn/*.out.256.100.*',
    'corpus decode qpack-06/quinn/*.out.512.100.*',
    'corpus decode qpack-06/quinn/*.out.4096.100.*',
    'corpus decode qpack-06/qthingey/*.out.256.100.*',
    'corpus decode qpack-06/qthingey/*.out.512.100.*',
    'corpus decode qpack-06/qthingey/*.out.4096.100.*',
    'corpus decode qpack-06/qthingey/*.out.256.0.1 *',
    'corpus decode qpack-06/qthingey/*.out.512.0.1 *',
    'corpus decode qpack-06/qthingey/*.out.4096.0.1 *',
    'corpus decode qpack-06/examples/* (table size 220)',
    'corpus decode qpack-06/draft-examples.out (table size 4096)',
    'decode cross-check * (table 256, *',
    'decode cross-check * (table 4096, *',

    // Stage 5: encoding with a dynamic table. Round-trip and cross-check
    // correctness at non-zero table sizes already passes (a static-only
    // encoder is valid at any settings), so the gate is the compression
    // tests, at the settings where ls-qpack itself gets meaningful gains
    // over static-only encoding:
    'compression * (table 4096, blocked 0, ack 1) *',
    'compression * (table 4096, blocked 100, ack 1) *',
    'compression fb-resp-hq (table 4096, blocked 100, ack 0) *',
    'compression netbsd (table 256, blocked 100, *',
    'compression netbsd-hq (table 256, blocked 100, *',
    'compression netbsd (table 4096, blocked 100, ack 0) *',
    'compression netbsd-hq (table 4096, blocked 100, ack 0) *',

    // Stage 6: error handling & hardening (err1-err8 are already rejected
    // by parsing strictness; these two involve dynamic table validation)
    'error corpus errors/err11 is rejected',
    'error corpus errors/err12 is rejected'
];
