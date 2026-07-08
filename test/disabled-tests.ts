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

    // Stage 6: error handling & hardening (the other error corpus files
    // are already rejected by parsing and dynamic table validation)
    'error corpus errors/err12 is rejected'
];
