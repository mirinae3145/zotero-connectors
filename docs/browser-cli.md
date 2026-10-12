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
It polls an authenticated loopback broker and only supports opening or inspecting publication tabs, listing tabs and targets, and invoking save.
It neither exports cookies nor accepts arbitrary JavaScript commands.
`browser save --url URL` opens the publication without requiring the user to create a tab.
`browser open URL` and `browser inspect --tab-id ID` support inspecting access or login before saving.
The Connector waits up to 30 seconds for detection or a transient challenge to clear.
A remaining common challenge-page title stops the save with `needs_user_action`; a detection timeout returns `loading`.
Resolve a login or CAPTCHA in the paired browser, then save the same tab ID.
This does not automatically solve CAPTCHAs or reuse another browser profile's authentication.
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

## Background tabs and responsibility boundaries

`browser open URL --background` and `browser save --url URL --background` create an inactive tab without focusing its window.
Without the flag, URL commands retain foreground behavior.
This uses a running browser with its existing session; it is not headless execution and does not launch a browser process.

For an unattended save, add `--close-on-success` to a background URL save.
Only a tab created by that very request can be closed, after a confirmed successful receipt.
Existing tabs (including a tab retained from an earlier open or failed save) are never automatically closed.
Failures, uncertain outcomes and tabs activated, pinned or navigated elsewhere during saving are retained.
Results expose `tab.createdByRequest`, and when cleanup is requested, `tab.closed` plus a `tab.closeReason` when retained.
A cleanup failure does not invalidate a successful save; do not repeat the save to retry cleanup.
Closing a tab follows storage confirmation, not independent verification of the paper's identity or completeness.

Use `browser focus --tab-id ID` explicitly when a retained tab needs user interaction, then resume saving with `--tab-id ID`.
The Connector does not automatically focus failed tabs, solve CAPTCHAs, or control third-party challenge extensions.
Such extensions are optional browser-environment components; page readiness determines whether saving proceeds.

The Connector owns tab execution and conservative cleanup; the CLI/broker owns transport, job IDs and receipt recovery.
The caller owns duplicate checks, paper verification, retry limits and deciding when to notify the user or focus a tab.
A future headless launcher would own browser processes and profiles separately.

```sh
zotero-cli --json browser save --url https://doi.org/10.1002/pola.11083 --target L4 --background --close-on-success
zotero-cli --json browser focus --tab-id 42
zotero-cli --json browser save --tab-id 42 --target L4
```

Use the actual target and tab IDs returned in your environment.
Update both forks together to use these options; older Connectors may ignore unsupported request fields.

## Batch acquisition

Run `browser batch URL1 URL2 ... --target TARGET_ID` for new publications after checking the intended library for duplicates.
The caller must omit existing items with missing PDFs when its policy is to report them; the batch command does not query the library or repair existing items.
The command saves sequentially in background tabs, with a default two-second interval between papers (`--interval`, 0.5–60 seconds).
Confirmed saves close eligible request-created tabs using the same conservative cleanup rules as `save`.
It never focuses tabs during the automatic pass.

Completed challenge/loading results and detected multiple-item selectors are collected in `deferred`; terminal partial-save failures are collected in `failed`.
After the pass, review the combined report and handle retained tabs together, using `focus` only when interaction is needed.
Do not resubmit a partial save before checking its items and attachments.
User-touched successful tabs remain open; the caller must not close them to force a completely empty success-tab list.

The JSON envelope's `data` contains `completed`, `deferred`, `failed`, `unattempted` and `stopped`.
Any incomplete batch returns `ok: false` and exit code 1 while preserving all outcomes.
A timeout or unknown save outcome stops new submissions and retains the original job ID for `browser result`.
A shared setup or destination failure also stops the pass rather than repeating it for every paper.
An unexpected prompt inside an already-running translator/download may therefore stop a batch: this is not cancellation or a guarantee of fully unattended execution.
The broker serializes commands, so a still-running save also queues `focus`/`inspect`; ask the user to visit that tab directly while recovering the original result.

Do not combine a second independent batch with an unresolved first batch on the same broker.
Upgrade both forks together for batch preflight deferral.

### Explicit save destination

`browser save --url URL --destination TARGET_ID` and `browser batch URL1 URL2 --destination TARGET_ID`
use the Connector popup's native `updateSession` operation after saving and attachment processing finish.
Discover `L`/`C` desktop IDs with `browser targets`; these are not web API library IDs.
The initial selected library must also allow file saving: the item is initially created there,
then the same save session is moved to the requested library or collection, including its attachments.
Zotero's visible selection changes. This is not an atomic save directly to the destination.
`--target` remains an optional initial-selection guard; with batch `--destination`, it guards only
its first paper, since the operation changes selection itself. Without `--destination`, it guards every paper.
A batch requires at least one of these options.

Upgrade the CLI/runtime, running broker and Connector together, then reload the extension.
The CLI checks destination support before submitting a save. A confirmed result contains
`destinationApplied: true` and `target` matching the requested destination.
Movement failure/uncertainty preserves the session receipt and tab and stops the batch; inspect Zotero before retrying.
A reused page session cannot be moved to a different destination by this command. The retained page popup
may still show its original destination; inspect Zotero and the returned receipt instead of using that popup to retry or move it.
Avoid editing the save popup while the automatic save/move is running.
PDF validation still applies after movement; inspect the actual final-library item and PDF for correct content.
The move uses native session identifiers, not a library search followed by a separate item move.

## Timing controls

- `browser batch --interval SECONDS` controls the gap after one paper's result and before the next submission. Default: 2 seconds; range: 0.5–60. It does not control page loading or translator detection. Individual `save` calls have no batch gap; callers pacing separate saves own their interval.
- `browser save|batch --ready-timeout SECONDS` controls page readiness polling. Default: 30 seconds; range: 0.5–120. A PDF save waits for an actual translator or PDF even after an empty detection callback. It proceeds immediately when ready. `open` and `save --allow-no-pdf` do not require a publication translator.
- `--timeout SECONDS` controls the CLI's wait for each job (default: 120). Choose a value larger than the readiness budget with enough time for PDF downloads. A client timeout does not cancel a running save; recover its job with `browser result`.

For example: `zotero-cli --json browser batch URL1 URL2 --destination TARGET_ID --interval 5 --ready-timeout 60 --timeout 180`.
These are per-invocation options, not persistent profile settings. Update both forks and reload the Connector for readiness waiting.
If detection expires with no translator, the result is `state: loading`, `waitingFor: translator`, and no write starts.
This may indicate slow detection or an unsupported page; it is not proof of a CAPTCHA or a need for human intervention.
After the automatic pass, inspect retained tabs and resume the same tab once only if a concrete condition has changed, such as a newly detected translator.
