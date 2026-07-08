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

    // Stage 3: static table, and encoding/decoding with the dynamic table
    // disabled (capacity 0)
    'static table *',
    'RFC 9204 appendix B B.1 *',
    'corpus decode * (table size 0)',
    'round trip * (table 0, *',
    'encode cross-check * (table 0, *',
    'decode cross-check * (table 0, *',

    // Stage 4: decoding with a dynamic table
    'RFC 9204 appendix B B.2 *',
    'RFC 9204 appendix B B.3 *',
    'RFC 9204 appendix B B.4 *',
    'RFC 9204 appendix B B.5 *',
    'corpus decode * (table size 256)',
    'corpus decode * (table size 512)',
    'corpus decode * (table size 4096)',
    'corpus decode * (table size 220)',
    'decode cross-check * (table 256, *',
    'decode cross-check * (table 4096, *',

    // Stage 5: encoding with a dynamic table
    'round trip * (table 256, *',
    'round trip * (table 4096, *',
    'encode cross-check * (table 256, *',
    'encode cross-check * (table 4096, *',

    // Stage 6: error handling & hardening
    'error corpus *'
];
