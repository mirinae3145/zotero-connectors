// Node contract tests: node --test test/browserBridge.unit.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
function context() {
    const c = { URL, console, setTimeout, AbortSignal, calls: [], selected: {
        id: null, libraryID: 4, libraryName: 'Group', libraryEditable: true, filesEditable: true,
        targets: [{id: 'L4', name: 'Group'}]
    }};
    c.Zotero = {
        initDeferred: { promise: { then() {} } },
        Prefs: { get: () => false },
        Connector: { checkIsOnline: async () => true, callMethod: async () => c.selected },
        Connector_Browser: { getTabInfo: () => ({translators: [], detectionDone: true}),
            onZoteroButtonElementClick: async (...args) => { c.calls.push(args); return c.receipt; } }
    };
    c.browser = { tabs: { get: async id => ({id, url: 'https://journal.example/article'}),
        query: async () => [{id: 1, url: 'https://journal.example/article?token=secret', title: 'Paper'}] } };
    c.receipt = {sessionID: 'session', desktopSaved: true, target: 'L4', items: [{attachments: [{mimeType: 'application/pdf', stored: true}]}]};
    vm.createContext(c);
    vm.runInContext(fs.readFileSync(path.join(root, 'src/browserExt/browserBridge.js'), 'utf8'), c);
    return c;
}
test('uses the toolbar entry point and keeps a group target', async () => {
    const c = context();
    const result = await c.Zotero.BrowserBridge.execute({action: 'save', tab_id: 1, target: 'L4'});
    assert.equal(result.ok, true);
    assert.equal(result.libraryID, 4);
    assert.equal(c.calls.length, 1);
    assert.equal(c.calls[0][1].cliSave, true);
});
test('mismatched target prevents a write', async () => {
    const c = context();
    await assert.rejects(c.Zotero.BrowserBridge.execute({action: 'save', tab_id: 1, target: 'L1'}), /Select L1/);
    assert.equal(c.calls.length, 0);
});
test('metadata alone or linked PDF is not acquisition success', async () => {
    for (const attachments of [[], [{mimeType: 'application/pdf', stored: false}]]) {
        const c = context(); c.receipt.items[0].attachments = attachments;
        const result = await c.Zotero.BrowserBridge.execute({action: 'save', tab_id: 1});
        assert.equal(result.ok, false);
        assert.equal(result.sessionID, 'session');
    }
});
test('tabs do not disclose signed query strings', async () => {
    const result = await context().Zotero.BrowserBridge.execute({action: 'tabs'});
    assert.equal(result.tabs[0].url, 'https://journal.example/article');
});
test('page receipts track failed, stored and linked attachments separately', () => {
    const c = context();
    Object.assign(c.Zotero, {Messaging: {sendMessage() {}}, ItemTypes: {getImageSrc() {}}, getString: s => s});
    vm.runInContext(fs.readFileSync(path.join(root, 'src/common/inject/pageSaving.js'), 'utf8'), c);
    const page = c.Zotero.PageSaving;
    page.sessionDetails = {id: 's', items: [{id: 'p', title: 'Paper'}]};
    for (const [id, progress, snapshot] of [['failed', false, true], ['stored', 100, true], ['linked', 100, false]]) {
        page._onAttachmentProgress({id, parentItem: 'p', mimeType: 'application/pdf', snapshot}, progress);
    }
    const attachments = page._cliReceipt().items[0].attachments;
    assert.equal(attachments.find(a => a.connectorAttachmentID === 'stored').stored, true);
    assert.equal(attachments.find(a => a.connectorAttachmentID === 'failed').stored, false);
    assert.equal(attachments.find(a => a.connectorAttachmentID === 'linked').stored, false);
});

test('previous receipt from another target cannot be reported as a new group save', async () => {
    const c = context(); c.receipt.target = 'L1';
    const result = await c.Zotero.BrowserBridge.execute({action: 'save', tab_id: 1, target: 'L4'});
    assert.equal(result.ok, false);
});
test('detection must complete before invoking the toolbar action', async () => {
    const c = context(); c.Zotero.Connector_Browser.getTabInfo = () => ({translators: []});
    await assert.rejects(c.Zotero.BrowserBridge.execute({action: 'save', tab_id: 1}), /not ready/);
    assert.equal(c.calls.length, 0);
});
