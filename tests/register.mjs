import { register } from 'node:module';
register('./loader.mjs', import.meta.url);

// No real network in tests: any fetch a test has not stubbed fails loudly
// (and fast) instead of reaching the internet.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { throw new Error(`real network call blocked in tests: ${String(url).slice(0, 120)}`); };
globalThis.__realFetch = realFetch;
