import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as url from 'node:url';

import { expect } from 'chai';

import { STATIC_TABLE } from '../src/static-table.js';
import type { HeaderField } from '../src/index.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

// This fixture was extracted from RFC 9204 appendix A, and cross-checked
// against ls-qpack's static table (including its recorded string lengths,
// which catch the ambiguous line-wrapping in the RFC's text rendering).
const EXPECTED_TABLE: HeaderField[] = JSON.parse(
    await fs.readFile(path.join(HERE, 'fixtures', 'static-table.json'), 'utf8')
);

describe('static table', () => {

    it('fixture is a plausible copy of RFC 9204 appendix A', () => {
        expect(EXPECTED_TABLE.length).to.equal(99);
        expect(EXPECTED_TABLE[0]).to.deep.equal({ name: ':authority', value: '' });
        expect(EXPECTED_TABLE[1]).to.deep.equal({ name: ':path', value: '/' });
        expect(EXPECTED_TABLE[17]).to.deep.equal({ name: ':method', value: 'GET' });
        expect(EXPECTED_TABLE[98]).to.deep.equal({ name: 'x-frame-options', value: 'sameorigin' });
        expect(EXPECTED_TABLE[58]).to.deep.equal({
            name: 'strict-transport-security',
            value: 'max-age=31536000; includesubdomains; preload'
        });
    });

    it('matches RFC 9204 appendix A', () => {
        expect(STATIC_TABLE).to.deep.equal(EXPECTED_TABLE);
    });

});
