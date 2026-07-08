/**
 * Support for the explicit disabled-test list in test/disabled-tests.ts.
 *
 * All tests are defined with qit() instead of it(). Tests whose full title
 * matches a disabled pattern are still run, but are expected to fail: if a
 * disabled test passes, it fails the build until it's removed from the list,
 * so the list can only ever shrink honestly. A root-level after hook fails
 * the build if any listed pattern no longer matches any test.
 */
import { DISABLED_TESTS } from '../disabled-tests.js';

function globToRegExp(pattern: string): RegExp {
    const escaped = pattern.split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
    return new RegExp(`^${escaped}$`);
}

const disabledPatterns = DISABLED_TESTS.map((pattern) => ({
    pattern,
    regex: globToRegExp(pattern),
    matchCount: 0
}));

function findDisabledPattern(fullTitle: string) {
    return disabledPatterns.find(({ regex }) => regex.test(fullTitle));
}

export function qit(title: string, testFn: (this: Mocha.Context) => unknown): void {
    it(title, async function () {
        const fullTitle = this.test!.fullTitle();
        const disabled = findDisabledPattern(fullTitle);

        if (!disabled) {
            await testFn.call(this);
            return;
        }

        disabled.matchCount += 1;
        try {
            await testFn.call(this);
        } catch {
            return; // Failed as expected while disabled
        }
        throw new Error(
            `Test is disabled but now passes - remove it from ` +
            `test/disabled-tests.ts (matched pattern: "${disabled.pattern}"): ` +
            `"${fullTitle}"`
        );
    });
}

/**
 * Wraps a promise with a timeout, so tests of not-yet-implemented async
 * behaviour (e.g. blocked field sections that never unblock) fail promptly
 * instead of hitting the full mocha timeout.
 */
export function withTimeout<T>(promise: Promise<T>, ms = 1000): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`Timed out after ${ms}ms`)),
            ms
        );
        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error) => { clearTimeout(timer); reject(error); }
        );
    });
}

// Registers on the root suite when imported from any spec file, running
// after the entire test run:
after(function () {
    if (process.env.SKIP_DISABLED_CHECK) return;

    const unmatched = disabledPatterns.filter(({ matchCount }) => matchCount === 0);
    if (unmatched.length > 0) {
        throw new Error(
            'Disabled test patterns in test/disabled-tests.ts matched no ' +
            'tests (fix or remove them, or set SKIP_DISABLED_CHECK=1 when ' +
            'running a test subset):\n' +
            unmatched.map(({ pattern }) => `  "${pattern}"`).join('\n')
        );
    }

    const disabledCount = disabledPatterns.reduce((sum, p) => sum + p.matchCount, 0);
    if (disabledCount > 0) {
        console.log(`\n  ${disabledCount} known-failing tests are disabled ` +
            `(see test/disabled-tests.ts)`);
    }
});
