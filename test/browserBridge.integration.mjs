import puppeteer from 'puppeteer';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const py=process.env.PYTHON || 'python';
const mcp=process.env.ZOTERO_MCP_CHECKOUT;
if (!mcp) throw new Error('Set ZOTERO_MCP_CHECKOUT to the matching CLI fork');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'zotero-bridge-test-'));
const tokenFile=path.join(temp,'bridge.token');
const token='integration-only-token-not-a-real-credential-123456';
await fs.writeFile(tokenFile, token, {mode:0o600});
let port=0;
const broker=spawn(py,['-m','zotero_mcp.cli_standalone','browser','serve','--port',String(port),'--token-file',tokenFile],{cwd:mcp,env:{...process.env,PYTHONPATH:mcp+'/src'},stdio:['ignore','ignore','pipe']});
await new Promise((resolve,reject)=>{
 broker.stderr.on('data',d=>{const match=/listening on 127\.0\.0\.1:(\d+)/.exec(String(d));if(match){port=Number(match[1]);resolve();}});
 broker.on('exit',code=>reject(new Error(`Broker exited before startup: ${code}`)));
});
function makePDF() {
 const content='BT /F1 12 Tf 40 750 Td (Librarian browser bridge validation 2026-10-12) Tj 0 -24 Td (Downloaded with browser cookie and saved through Zotero Connector.) Tj ET';
 const objects=['<</Type/Catalog/Pages 2 0 R>>','<</Type/Pages/Kids[3 0 R]/Count 1>>',
 '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>',
 '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',`<</Length ${Buffer.byteLength(content)}>>\nstream\n${content}\nendstream`];
 let data='%PDF-1.4\n', offsets=[0];
 objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(data));data+=`${i+1} 0 obj\n${object}\nendobj\n`;});
 const xref=Buffer.byteLength(data);data+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
 data+=offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('');
 return Buffer.from(data+`trailer<</Size ${objects.length+1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`);
}
const pdf=makePDF();
let base, uploads=[], saves=[], cookieFetches=0, denyPDF=false, selectedLibrary=4, moves=[];
const fake=http.createServer(async(req,res)=>{
 const buffers=[];for await(const b of req)buffers.push(b); const bytes=Buffer.concat(buffers);
 res.setHeader('X-Zotero-Version','10.0.0');res.setHeader('Content-Type','application/json');
 const route=new URL(req.url,base||'http://127.0.0.1');
 const send=(x,status=200)=>{res.statusCode=status;res.end(JSON.stringify(x));};
 if(route.pathname==='/paper'){
  res.setHeader('Content-Type','text/html');res.setHeader('Set-Cookie','access=granted; Path=/; SameSite=Lax');
  res.end(`<html><head><title>Browser bridge integration paper</title><meta name="citation_title" content="Browser bridge integration paper"><meta name="citation_author" content="Fixture Author"><meta name="citation_date" content="2026"><meta name="citation_journal_title" content="Bridge Test"><meta name="citation_pdf_url" content="${base}/paper.pdf"></head><body>Browser-only PDF<iframe src="${base}/frame"></iframe></body></html>`);return;
 }
 if(route.pathname==='/detection-ready'){await new Promise(r=>setTimeout(r,1500));return send({ready:true});}
 if(route.pathname==='/frame'){res.setHeader('Content-Type','text/html');res.end('<html><body>Embedded frame</body></html>');return;}
 if(route.pathname==='/paper.pdf'){
  if(denyPDF || !req.headers.cookie?.includes('access=granted'))return send({error:'browser cookie required'},403);
  cookieFetches++;res.setHeader('Content-Type','application/pdf');res.end(pdf);return;
 }
 switch(route.pathname){
 case '/connector/ping':return send({prefs:{automaticSnapshots:false,downloadAssociatedFiles:true,automaticTags:true}});
 case '/connector/getSelectedCollection':return send({id:null,libraryID:selectedLibrary,libraryName:'Fixture Group',libraryEditable:true,filesEditable:true,editable:true,targets:[{id:'L4',name:'Fixture Group',level:0,filesEditable:true},{id:'L5',name:'Destination',level:0,filesEditable:true}]});
 case '/connector/updateSession': {const data=JSON.parse(bytes); moves.push(data);selectedLibrary=Number(data.target.slice(1));return send({});}
 case '/connector/saveItems':saves.push(JSON.parse(bytes));return send({items:JSON.parse(bytes).items},201);
 case '/connector/saveAttachment':uploads.push(bytes);return send({});
 case '/connector/hasAttachmentResolvers':return send(false);
 case '/connector/getTranslators':return send([]);
 default:return send({});
 }
});
await new Promise(resolve=>fake.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${fake.address().port}`;
const browser=await puppeteer.launch({headless:true,pipe:true,enableExtensions:[repo+'/build/manifestv3']});
async function cli(args){return new Promise((resolve,reject)=>{
 const p=spawn(py,['-m','zotero_mcp.cli_standalone','--json','browser',...args,'--port',String(port),'--token-file',tokenFile],{cwd:mcp,env:{...process.env,PYTHONPATH:mcp+'/src'},stdio:['ignore','pipe','pipe']});
 let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('exit',code=>{try{resolve({code,...JSON.parse(out)});}catch{reject(Error(out+err));}});
});}
try{
 const target=await browser.waitForTarget(t=>t.type()==='service_worker',{timeout:20000}); const worker=await target.worker();
 await worker.evaluate(async()=>{await Zotero.initDeferred.promise; await Zotero.Translators.init(); for(let n=0;n<300 && Zotero.Prefs.get('lastVersion')!==Zotero.version;n++) await new Promise(r=>setTimeout(r,100));});
 const meta={translatorID:'2f22f127-101f-4f9a-b498-999999999999',label:'Bridge fixture',creator:'Test',target:'^http://127\\.0\\.0\\.1:',minVersion:'3.0',maxVersion:'',priority:1,inRepository:true,translatorType:4,browserSupport:'gcsibv',lastUpdated:'2026-10-12 00:00:00'};
 const translatorCode=JSON.stringify(meta)+'\nasync function detectWeb(doc,url){if(url.includes("/frame"))return false;if(url.includes("late=1"))await Zotero.Utilities.HTTP.request("GET",new URL("/detection-ready",url).href);return "journalArticle";}\nfunction doWeb(doc,url){var item=new Zotero.Item("journalArticle");item.title="Browser bridge integration paper";item.url=url;item.attachments=[{title:"Full Text PDF",url:url.replace("/paper","/paper.pdf"),mimeType:"application/pdf"}];item.complete();}';
 await worker.evaluate(async({base,meta,translatorCode,token,port})=>{
  await Zotero.Prefs.set('connector.url',base+'/');await Zotero.Prefs.set('firstUse',false);
  await Zotero.Prefs.set('translatorMetadata',[meta]);
  await Zotero.Prefs.set(Zotero.Translators.PREFS_TRANSLATOR_CODE_PREFIX+meta.translatorID,translatorCode);
  Zotero.Translators._load([meta]);

 },{base,meta,translatorCode,token,port});
 const settings=await browser.newPage();
 const extensionURL=target.url().replace('background-worker.js','');
 await settings.goto(extensionURL+'preferences/preferences.html#advanced');
 await settings.waitForSelector('#browser-bridge-apply');
 await settings.evaluate(()=>Zotero.initDeferred.promise);
 await settings.locator('#browser-bridge-port').fill(String(port));
 await settings.locator('#browser-bridge-token').fill(token);
 await settings.locator('#browser-bridge-enabled').click();
 await settings.locator('#browser-bridge-apply').click();
 await settings.waitForFunction(()=>document.getElementById('browser-bridge-status').textContent.startsWith('Enabled.'));
 await settings.close();
 const page=await browser.newPage();await page.goto(base+'/paper');
 assert.equal((await fetch(base+'/paper.pdf')).status,403);
 const tabID=await worker.evaluate(async base=>(await browser.tabs.query({})).find(t=>t.url===base+'/paper').id,base);
 await worker.evaluate(async id=>{
  for(let n=0;n<100;n++){
   const info=Zotero.Connector_Browser.getTabInfo(id);
   if(info.translators?.length)return;
   await new Promise(r=>setTimeout(r,100));
  }
  throw Error('translator detection timed out: '+JSON.stringify(Zotero.Connector_Browser.getTabInfo(id))+' errors='+JSON.stringify(await Zotero.Errors.getErrors()));
 },tabID);
 await worker.evaluate(async id=>{
  const frames=await browser.webNavigation.getAllFrames({tabId:id});
  for(const frame of frames.filter(f=>f.frameId!==0)) {
   await browser.scripting.executeScript({target:{tabId:id,frameIds:[frame.frameId]},func:()=>{
    // Unrelated extension listeners can acknowledge a broadcast before the
    // selected translator frame finishes its asynchronous save.
    chrome.runtime.onMessage.addListener((message,_sender,respond)=>{
     if(message[0]==='translate'){respond(null);return false;}
    });
   }});
  }
 },tabID);
 for(let n=0;n<20;n++){const s=await cli(['status']);if(s.data?.connected)break;await new Promise(r=>setTimeout(r,200));}
 const result=await cli(['save','--tab-id',String(tabID),'--target','L4','--timeout','30']);
 console.log(JSON.stringify(result));
 assert.equal(result.ok,true);assert.equal(result.code,0);assert.equal(saves.length,1);assert.equal(uploads.length,1);assert.deepEqual(uploads[0],pdf);assert.ok(cookieFetches>0);
 const repeated=await cli(['save','--tab-id',String(tabID),'--target','L4','--timeout','30']);
 assert.equal(repeated.ok,true);assert.equal(saves.length,1);
 denyPDF=true;
 await page.reload();
 await worker.evaluate(async id=>{for(let n=0;n<100;n++){if(Zotero.Connector_Browser.getTabInfo(id).translators?.length)return;await new Promise(r=>setTimeout(r,100));}throw Error('redetection timeout');},tabID);
 const failed=await cli(['save','--tab-id',String(tabID),'--target','L4','--timeout','30']);
 assert.equal(failed.code,1);assert.equal(failed.ok,false);assert.equal(failed.data.result.ok,false);
 assert.equal(uploads.length,1);assert.equal(saves.length,2);
 // A normal toolbar click still returns its original translator items and saves once.
 denyPDF=false;
 await page.reload();
 await worker.evaluate(async id=>{for(let n=0;n<100;n++){if(Zotero.Connector_Browser.getTabInfo(id).translators?.length)return;await new Promise(r=>setTimeout(r,100));}throw Error('redetection timeout');},tabID);
 await worker.evaluate(async id=>Zotero.Connector_Browser.onZoteroButtonElementClick(await browser.tabs.get(id)),tabID);
 for(let n=0;n<100 && (uploads.length<2 || saves.length<3);n++) await new Promise(r=>setTimeout(r,100));
 assert.equal(uploads.length,2);assert.equal(saves.length,3);
 const opened=await cli(['open',base+'/paper?open=1']);
 assert.equal(opened.ok,true);assert.equal(opened.data.result.tab.state,'ready');
 const inspected=await cli(['inspect','--tab-id',String(opened.data.result.tab.id)]);
 assert.equal(inspected.ok,true);assert.equal(inspected.data.result.tab.state,'ready');
 const fromURL=await cli(['save','--url',base+'/paper?save=1','--target','L4','--timeout','30']);
 assert.equal(fromURL.ok,true);assert.equal(saves.length,4);assert.equal(uploads.length,3);
 // New background tabs must not replace the active tab, and close only on success.
 const activeBefore=await worker.evaluate(async()=> (await browser.tabs.query({active:true,currentWindow:true}))[0].id);
 const background=await cli(['save','--url',base+'/paper?background=1','--target','L4','--background','--close-on-success','--timeout','30']);
 assert.equal(background.ok,true);assert.equal(background.data.result.tab.closed,true);
 assert.equal(await worker.evaluate(async()=> (await browser.tabs.query({active:true,currentWindow:true}))[0].id),activeBefore);
 assert.equal(await worker.evaluate(async id=> (await browser.tabs.query({})).some(t=>t.id===id),background.data.result.tab.id),false);
 denyPDF=true;
 const retained=await cli(['save','--url',base+'/paper?background=failed','--target','L4','--background','--close-on-success','--timeout','30']);
 assert.equal(retained.ok,false);assert.equal(retained.data.result.tab.closed,false);
 const retainedID=retained.data.result.tab.id;
 assert.equal(await worker.evaluate(async id=> (await browser.tabs.get(id)).active,retainedID),false);
 const focused=await cli(['focus','--tab-id',String(retainedID)]);
 assert.equal(focused.ok,true);
 assert.equal(await worker.evaluate(async id=> (await browser.tabs.get(id)).active,retainedID),true);
 denyPDF=false;
 const batch=await cli(['batch',base+'/paper?batch=1',base+'/paper?batch=2','--target','L4','--interval','0.5','--timeout','30']);
 assert.equal(batch.ok,true);assert.equal(batch.data.completed.length,2);
 assert.ok(batch.data.completed.every(e=>e.result.tab.closed));
 assert.equal(batch.data.deferred.length,0);
 const lateStarted=Date.now();
 const late=await cli(['save','--url',base+'/paper?late=1','--destination','L4','--background','--close-on-success','--ready-timeout','10','--timeout','30']);
 assert.equal(late.ok,true,JSON.stringify(late));assert.equal(late.data.result.tab.closed,true);
 assert.equal(late.data.result.items[0].attachments[0].stored,true);
 assert.ok(Date.now()-lateStarted>=1500);
 console.log('PASS: asynchronous translator detection saves PDF without a second request');
 const moved=await cli(['save','--url',base+'/paper?destination=1','--target','L4','--destination','L5','--background','--close-on-success','--timeout','30']);
 assert.equal(moved.ok,true);assert.equal(moved.data.result.destinationApplied,true);
 assert.equal(moved.data.result.target,'L5');assert.equal(moved.data.result.libraryID,5);
 assert.equal(moved.data.result.tab.closed,true);assert.equal(moves.length,1);
 assert.equal(moves[0].sessionID,moved.data.result.sessionID);
 console.log('PASS: destination invokes native session update and confirms final target');
 console.log('PASS: CLI batch saves both PDFs and closes only generated tabs');
 console.log('PASS: background PDF save and cleanup, focus preservation, failed tab retention and explicit focus');
 console.log('PASS: actual translator, cookie-bound PDF, binary upload, repeat safety, failed-PDF receipt, ordinary toolbar save and URL-driven opening/saving');
}catch(e){console.error(e);process.exitCode=1;}
finally{await browser.close();fake.close();broker.kill();await fs.rm(temp,{recursive:true,force:true});}
