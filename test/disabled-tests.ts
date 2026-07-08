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

    // Stage 6: error handling & hardening (the other error corpus files
    // are already rejected by parsing and dynamic table validation)
    'error corpus errors/err12 is rejected'
];
