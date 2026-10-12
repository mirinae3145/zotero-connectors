// Node contract tests: node --test test/browserBridge.unit.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
function context() {
    const c = { URL, console, setTimeout: callback => callback(), AbortSignal, calls: [], selected: {
        id: null, libraryID: 4, libraryName: 'Group', libraryEditable: true, filesEditable: true,
        targets: [{id: 'L4', name: 'Group'}]
    }};
    c.Zotero = {
        initDeferred: { promise: { then() {} } },
        Prefs: { get: () => false },
        Connector: { checkIsOnline: async () => true, callMethod: async () => c.selected },
        Connector_Browser: { getTabInfo: () => ({translators: [{label:'Fixture'}], detectionDone: true}),
            onZoteroButtonElementClick: async (...args) => { c.calls.push(args); return c.receipt; } }
    };
    c.browser = { tabs: { get: async id => ({id, url: 'https://journal.example/article', status: 'complete'}),
        query: async () => [{id: 1, url: 'https://journal.example/article?token=secret', title: 'Paper'}] } };
    c.activated = new Set();
    c.browser.tabs.onActivated = {addListener: f => c.activated.add(f), removeListener: f => c.activated.delete(f)};
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
        page._onAttachmentProgress({id, parentItem: 'p', mimeType: 'application/pdf', snapshot}, progress, progress===false ? 'download failed' : undefined);
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
    const result = await c.Zotero.BrowserBridge.execute({action: 'save', tab_id: 1});
    assert.equal(result.ok, false);assert.equal(result.state, 'loading');
    assert.equal(c.calls.length, 0);
});

test('URL saving opens the tab itself and waits before the same toolbar call', async () => {
    const c = context(); let opened;
    c.browser.tabs.create = async options => {opened=options;return {id: 9};};
    const result = await c.Zotero.BrowserBridge.execute({action: 'save', url:'https://journal.example/article'});
    assert.equal(result.ok,true);assert.equal(opened.url,'https://journal.example/article');
    assert.equal(c.calls[0][0].id,9);
});
test('CAPTCHA title is returned before creating any library item', async () => {
    const c = context();
    c.browser.tabs.get = async id => ({id,url:'https://journal.example/article',title:'Just a moment...',status:'complete'});
    const result = await c.Zotero.BrowserBridge.execute({action:'save',tab_id:1});
    assert.equal(result.ok,false);assert.equal(result.state,'needs_user_action');assert.equal(c.calls.length,0);
});

test('a publisher re-detection during saving does not erase the CLI receipt', async () => {
    const c = context();
    Object.assign(c.Zotero, {
        Messaging:{sendMessage:async()=>undefined},
        Inject:{checkActionToServer:async()=>true},
        Utilities:{randomString:()=> 'stable-session'},
        Promise:{delay:async()=>{}},debug(){},logError(){}
    });
    c.document={location:{href:'https://journal.example/article'}};
    vm.runInContext(fs.readFileSync(path.join(root,'src/common/inject/pageSaving.js'),'utf8'),c);
    const page=c.Zotero.PageSaving;
    page.translators=[{translatorID:'t',label:'Fixture',itemType:'journalArticle'}];
    page.translateAndSave=async function(){
        const session=this.sessionDetails;
        session.items=[{id:'parent',title:'Paper'}];
        session.desktopSaved=true;session.target='L4';
        session.attachmentProgress={pdf:{parentItem:'parent',mimeType:'application/pdf',stored:true}};
        this.sessionDetails={}; // asynchronous publisher re-detection replaced the active page state
        return session.items;
    };
    const result=await page.onTranslate('t',{cliSave:true});
    assert.equal(result.sessionID,'stable-session');
    assert.equal(result.items[0].attachments[0].stored,true);
});

test('transient challenge can clear before requesting user intervention', async () => {
    const c=context();let reads=0;
    c.browser.tabs.get=async id=>({id,url:'https://journal.example/article',status:'complete',title:++reads<3?'Just a moment...':'Paper'});
    const result=await c.Zotero.BrowserBridge.execute({action:'save',tab_id:1});
    assert.equal(result.ok,true);assert.ok(reads>=3);
});
test('destination change while opening a URL stops before writing', async () => {
    const c=context();
    c.browser.tabs.create=async()=>{c.selected={...c.selected,libraryID:1};return {id:9};};
    const result=await c.Zotero.BrowserBridge.execute({action:'save',url:'https://journal.example/article'});
    assert.equal(result.ok,false);assert.equal(c.calls.length,0);
});

function backgroundContext() {
    const c = context();
    c.tab = {id: 9, windowId: 2, url: 'https://journal.example/article', status: 'complete', active: false};
    c.browser.tabs.create = async options => {c.openOptions = options; return c.tab;};
    c.browser.tabs.get = async () => c.tab;
    c.browser.tabs.remove = async id => {c.removed = id;};
    return c;
}
const backgroundSave = {action:'save',url:'https://journal.example/article',background:true,close_on_success:true};
test('background success closes only its created inactive tab', async () => {
    const c=backgroundContext();const result=await c.Zotero.BrowserBridge.execute(backgroundSave);
    assert.equal(c.openOptions.active,false);assert.equal(c.removed,9);
    assert.equal(result.ok,true);assert.equal(result.tab.closed,true);assert.equal(c.activated.size,0);
});
test('partial save keeps its background tab and receipt', async () => {
    const c=backgroundContext();c.receipt.items[0].attachments=[];
    const result=await c.Zotero.BrowserBridge.execute(backgroundSave);
    assert.equal(result.ok,false);assert.equal(result.tab.closed,false);assert.equal(c.removed,undefined);
    assert.equal(result.sessionID,'session');
});
test('challenge and unknown outcomes retain the created tab ID', async () => {
    const c=backgroundContext();c.tab.title='Just a moment...';
    let result=await c.Zotero.BrowserBridge.execute(backgroundSave);
    assert.equal(result.state,'needs_user_action');assert.equal(result.tab.id,9);assert.equal(c.removed,undefined);
    c.tab.title='Paper';c.Zotero.Connector_Browser.onZoteroButtonElementClick=async()=>{throw Error('private URL');};
    result=await c.Zotero.BrowserBridge.execute(backgroundSave);
    assert.equal(result.state,'outcome_unknown');assert.equal(result.tab.id,9);assert.equal(c.removed,undefined);
    assert.ok(!result.error.includes('private URL'));
});
test('existing tabs are never automatically closed', async () => {
    const c=backgroundContext();const result=await c.Zotero.BrowserBridge.execute({action:'save',tab_id:9,close_on_success:true});
    assert.equal(result.ok,true);assert.equal(result.tab.closeReason,'existing_tab');assert.equal(c.removed,undefined);
});
test('user activation, pinning or navigation preserves the tab', async () => {
    for(const change of ['activation','pin','url']) {
        const c=backgroundContext();
        c.Zotero.Connector_Browser.onZoteroButtonElementClick=async()=>{
            if(change==='activation') for(const f of c.activated) f({tabId:9});
            if(change==='pin') c.tab.pinned=true;
            if(change==='url') c.tab.url='https://journal.example/other';
            return c.receipt;
        };
        const result=await c.Zotero.BrowserBridge.execute(backgroundSave);
        assert.equal(result.ok,true);assert.equal(c.removed,undefined);assert.equal(result.tab.closeReason,'tab_changed_or_activated');
    }
});
test('cleanup failure preserves successful receipt', async () => {
    const c=backgroundContext();c.browser.tabs.remove=async()=>{throw Error('closed elsewhere');};
    const result=await c.Zotero.BrowserBridge.execute(backgroundSave);
    assert.equal(result.ok,true);assert.equal(result.sessionID,'session');assert.equal(result.tab.closeReason,'cleanup_unavailable');
});
test('focus explicitly activates the requested tab and its window', async () => {
    const c=backgroundContext();c.browser.tabs.update=async(id,options)=>{c.focusTab={id,...options};};
    c.browser.windows={update:async(id,options)=>{c.focusWindow={id,...options};}};
    const result=await c.Zotero.BrowserBridge.execute({action:'focus',tab_id:9});
    assert.equal(result.ok,true);assert.equal(c.focusTab.id,9);assert.equal(c.focusTab.active,true);
    assert.equal(c.focusWindow.id,2);assert.equal(c.focusWindow.focused,true);assert.equal(c.calls.length,0);
});

test('batch defers multiple-item selectors before invoking a save', async () => {
    const c=backgroundContext();
    c.Zotero.Connector_Browser.getTabInfo=()=>({detectionDone:true,translators:[{label:'Search results',itemType:'multiple'}]});
    const result=await c.Zotero.BrowserBridge.execute({...backgroundSave,defer_user_action:true});
    assert.equal(result.state,'needs_user_action');assert.equal(c.calls.length,0);assert.equal(c.removed,undefined);
});
