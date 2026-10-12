# Browser CLI

This fork pairs with the `browser` commands in the zotero-mcp fork.
Build with `./build.sh -d`, load `build/manifestv3` as an unpacked extension in Chrome or Edge (or `build/firefox/manifest.json` in Firefox), and complete the first-use prompt.
Start Zotero desktop before saving.

1. Run `zotero-cli browser serve` in a terminal on the browser's localhost network.
1. Open Connector preferences → Advanced → Browser CLI.
1. Enter port `23120` and the contents of the token file shown by the CLI, enable Browser CLI, and click Apply.
1. Open a publication tab and use `zotero-cli --json browser tabs` to get its ID.
1. Use `zotero-cli --json browser targets` to inspect the selected Zotero target.
1. Run `zotero-cli --json browser save --tab-id TAB_ID --target TARGET_ID`.

The optional target argument guards the current Zotero selection; select the destination in Zotero first.
It accepts the returned Connector tree ID, not a Zotero web API group ID.
The CLI requires a confirmed stored PDF by default; `--allow-no-pdf` permits metadata-only saves.
The browser may display a login, item selector or Connector permission dialog while the CLI waits.

This transport is disabled until paired.
It polls an authenticated loopback broker and only supports listing tabs, inspecting targets and invoking save.
It neither exports cookies nor accepts arbitrary JavaScript commands.
Tab listings omit URL query strings and fragments.
Use a different port and token for each browser profile.
Safari is not supported by this transport.

## Save receipts

The bridge calls `onZoteroButtonElementClick` and retains the existing translator fallback and browser attachment pipeline.
It waits for the save result and distinguishes stored attachments, linked attachments and failed downloads.
Group libraries use Zotero's current save destination, as with the toolbar.
An automated save requires desktop Zotero and does not fall back to an online personal library when desktop access fails.

The receipt carries a session ID and session-local item/attachment IDs, titles, MIME types and completion states.
These IDs are not database item keys, and a receipt does not certify the publisher version or completeness of a PDF.
A failure can occur after metadata was saved; inspect that result before retrying.

After a timeout, use `zotero-cli --json browser result JOB_ID` to retrieve the original result.
Claimed jobs are not replayed after a lost response or worker restart.
The extension retains a pending receipt until acknowledged; the broker retains results only for its process lifetime.

## Protocol and tests

Protocol version 1 uses bearer-authenticated JSON over `127.0.0.1`.
The CLI submits `/jobs`, the extension claims work through `/poll` and acknowledges `/jobs/ID`.
One broker pairs to one extension profile and serializes jobs.
The extension setting `browserBridge` is stored in local extension storage with `enabled`, `port`, `token` and a stable `client` ID.
Do not put pairing tokens in diagnostics.

Run the lightweight contract tests with `node --test test/browserBridge.unit.cjs`.
The normal build and existing browser suite remain available through the repository's build and test commands.

For the full browser transport test, build first and supply a Python environment that can run the matching CLI checkout:

```sh
ZOTERO_MCP_CHECKOUT=/path/to/zotero-mcp PYTHON=/path/to/python node test/browserBridge.integration.mjs
```

This starts an isolated Chromium profile, a cookie-protected fixture publisher, a mock Zotero endpoint and the actual CLI broker.
It runs the real translator and attachment pipeline, checks the uploaded bytes and repeat-save behavior, and verifies a PDF failure after metadata creation.
It does not write to your Zotero library.
