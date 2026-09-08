# Customer-experience qualification

The tests use public synthetic values only. They do not load a wallet, submit
payment, call a seller or read production state.

With the repository's hash-locked Python dependencies and Node 24 installed:

```sh
python integration/website/export_fixture.py
npm --prefix integration/website ci --ignore-scripts
node integration/website/schema-check.mjs
node integration/website/browser.mjs
node integration/website/extended.mjs
```

Install the pinned Playwright Chromium/WebKit binaries in this isolated testing
environment before running the browser scripts. The production image does not
need browser or schema-test dependencies.

The exporter starts the actual Python HTTP handler on loopback in fixture mode,
then saves its generated OpenAPI and MCP descriptions, transparency, dashboard,
route page and public fixture snapshot. The browser's exact-path server serves
these generated pages alongside the current static assets under the production
content-security policy. Browser requests are GET-only and restricted to that
loopback origin.

Coverage includes 320, 360, 375, 390, 414, 768 and 1440 CSS-pixel portrait widths,
Chromium and WebKit, mobile/touch emulation, landscape reflow, focus, input sizes,
long and untrusted text, no-payment sample states, exact-URL request construction,
sub-cent/invalid/absent limits, search races and error states. Actual OpenAPI
examples and malformed profile requests are checked with Ajv without coercion;
MCP remains a separate closed advertisement.

These are browser and fixture tests, not physical iPhone/Safari tests, production
payment qualification, an accessibility certification or independent security
approval. Screenshots are generated in `website-evidence/` for inspection; do
not call their existence a completed visual review. This workflow does not alter
repository permissions or upload artifacts through an unapproved action.
