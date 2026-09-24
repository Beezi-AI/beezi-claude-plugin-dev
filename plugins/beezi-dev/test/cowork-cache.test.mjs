import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import v8 from 'v8';
import { scanCoworkCache, normalizeCoworkRecords, discoverCoworkRoots, getCoworkCacheFingerprint } from '../lib/cowork-cache.mjs';
import { replayWal, decodeIndexedValue, decodeTable, decodeManifest } from '../lib/cowork-leveldb.mjs';

function vi(n) { const a=[]; do { let c=n%128;n=Math.floor(n/128);a.push(c|(n?128:0)); } while(n); return Buffer.from(a); }
function str(b) { b=Buffer.from(b);return Buffer.concat([vi(b.length),b]); }
function crc(b) { let c=0xffffffff;for(const x of b){c^=x;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0x82f63b78:0);}return (~c)>>>0; }
function masked(b) { const c=crc(b);return (((c>>>15)|(c<<17))+0xa282ead8)>>>0; }
function wal(records) { const chunks=[];let used=0;for(const record of records){let p=0;do { if(32768-used<7){chunks.push(Buffer.alloc(32768-used));used=0;}const n=Math.min(32768-used-7,record.length-p);const type=p===0?(n===record.length?1:2):(p+n===record.length?4:3);const part=record.subarray(p,p+n);const h=Buffer.alloc(7);h.writeUInt32LE(masked(Buffer.concat([Buffer.from([type]),part])));h.writeUInt16LE(n,4);h[6]=type;chunks.push(h,part);p+=n;used+=7+n;if(used===32768)used=0;}while(p<record.length);}return Buffer.concat(chunks); }
function batch(seq,entries) { const h=Buffer.alloc(12);h.writeBigUInt64LE(BigInt(seq));h.writeUInt32LE(entries.length,8);return Buffer.concat([h,...entries.map(([k,v])=>Buffer.concat([Buffer.from([v===null?0:1]),str(k),...(v===null?[]:[str(v)])]))]); }
function value(o) { return Buffer.concat([Buffer.from([1]),v8.serialize(o)]); }
function idbKey() { const name='cowork:cse_test',utf=Buffer.from(name,'utf16le');utf.swap16();return Buffer.concat([Buffer.from([0,3,1,1,1]),vi(name.length),utf]); }
const sid='11111111-1111-4111-8111-111111111111';
function tree(events,id='cowork:cse_test') { return {conversationUuid:id,product:'cowork',writtenAt:'2026-01-02T00:00:00Z',tree:{kind:'cowork_remote',events,headSeq:9,hasOlder:false}}; }
function result(seq,n,session=sid) { return {seq,payload:{type:'result',session_id:session,created_at:'2026-01-01T00:00:00Z',total_cost_usd:n/10,modelUsage:{'model-test':{inputTokens:n,outputTokens:n*2,cacheReadInputTokens:0,cacheCreationInputTokens:0,costUSD:n/10}}}}; }
function temp(t) { const d=fs.mkdtempSync(path.join(os.tmpdir(),'cowork-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d; }

test('WAL reconstructs fragmented values and chooses highest sequence, including deletes',()=>{
 const big=Buffer.alloc(70000,42);const state=replayWal([wal([batch(20,[['a',big],['gone',null]])]),wal([batch(2,[['a',Buffer.from('old')],['gone',Buffer.from('stale')]])])]);
 assert.equal(state.get(Buffer.from('a').toString('hex')).value.length,70000);assert.equal(state.get(Buffer.from('gone').toString('hex')).value,null);
});
test('WAL rejects corruption and incomplete tails instead of returning stale snapshots',()=>{
 const good=wal([batch(1,[['a',Buffer.from('ok')]])]);const bad=Buffer.from(good);bad[9]^=1;
 assert.throws(()=>replayWal([bad]),/checksum/i);assert.throws(()=>replayWal([good.subarray(0,good.length-1)]),/truncat/i);
});
test('V8 plain data decoder reads values and references and refuses unknown versions/tags',()=>{
 const shared={hi:'hello',unicode:'Привіт'};const o={a:shared,b:shared,arr:[1,-3,2.5,null,true,undefined],empty:[]};
 const got=decodeIndexedValue(value(o));assert.deepEqual(got,o);assert.equal(got.a,got.b);
 assert.throws(()=>decodeIndexedValue(Buffer.from([1,255,99,111,123,0])),/version/i);
 assert.throws(()=>decodeIndexedValue(Buffer.concat([Buffer.from([1]),v8.serialize(new Map([['x',1]]))])),/tag/i);
});
test('normalization selects cumulative snapshots, separates engine resets, excludes Chat and text',()=>{
 const second='22222222-2222-4222-8222-222222222222';const o=tree([result(1,2),result(2,5),result(3,1,second),{seq:4,payload:{type:'assistant',message:{id:'msg1',content:[{type:'text',text:'PRIVATE'},{type:'tool_use',id:'tool1',name:'Write',input:{secret:'PRIVATE'}}]}}},{seq:5,payload:{type:'assistant',message:{id:'msg1',content:[{type:'tool_use',id:'tool1',name:'Write'}]}}}]);
 const sessions=normalizeCoworkRecords([{object:o,sequence:3n}],{mtimeMs:1,size:10});
 assert.equal(sessions.length,2);assert.equal(sessions[0].costState.modelUsage['model-test'].inputTokens,5);assert.equal(sessions[1].costState.modelUsage['model-test'].inputTokens,1);assert.equal(JSON.stringify(sessions).includes('PRIVATE'),false);
 assert.equal(normalizeCoworkRecords([{object:{...o,product:'chat'},sequence:4n}],{}).length,0);
 assert.equal(normalizeCoworkRecords([{object:o,sequence:3n},{object:{conversationUuid:o.conversationUuid,tombstone:true},sequence:4n}],{}).length,0);
});
test('scanner reports unsupported or malformed storage without partial sessions', t=>{
 const root=temp(t),db=path.join(root,'IndexedDB','https_claude.ai_0.indexeddb.leveldb');fs.mkdirSync(db,{recursive:true});fs.writeFileSync(path.join(db,'000003.log'),wal([batch(1,[['key',value(tree([result(1,5)]))]])]));
 const out=scanCoworkCache({roots:[root]});assert.equal(out.sessions.length,0);assert.ok(out.warnings.length); // CURRENT is required for authoritative live-file selection.
});

// Minimal valid LevelDB table builder, using one data block and an index block.
function block(entries) { let offset=0;const chunks=[];for(const [k,v]of entries){const e=Buffer.concat([vi(0),vi(k.length),vi(v.length),k,v]);chunks.push(e);offset+=e.length;}const tail=Buffer.alloc(8);tail.writeUInt32LE(0);tail.writeUInt32LE(1,4);return Buffer.concat([...chunks,tail]); }
function framed(b) { const tail=Buffer.alloc(5);tail[0]=0;tail.writeUInt32LE(masked(Buffer.concat([b,Buffer.from([0])])),1);return Buffer.concat([b,tail]); }
function internal(k,seq,type=1){const tail=Buffer.alloc(8);tail.writeBigUInt64LE((BigInt(seq)<<8n)|BigInt(type));return Buffer.concat([Buffer.from(k),tail]);}
function table(entries) { const data=framed(block(entries));const meta=framed(block([]));const index=framed(block([[entries.at(-1)[0],Buffer.concat([vi(0),vi(data.length-5)])]]));const footer=Buffer.alloc(48);Buffer.concat([vi(data.length),vi(meta.length-5),vi(data.length+meta.length),vi(index.length-5)]).copy(footer);Buffer.from('57fb808b247547db','hex').copy(footer,40);return Buffer.concat([data,meta,index,footer]); }
function manifest(log,tables,deleted=[]) { return wal([Buffer.concat([vi(1),str('leveldb.BytewiseComparator'),vi(2),vi(log),...tables.map(n=>Buffer.concat([vi(7),vi(0),vi(n),vi(100),str('a'),str('z')])),...deleted.map(n=>Buffer.concat([vi(6),vi(0),vi(n)]))])]); }
test('SST table reads internal-key sequences and delete markers with checked block integrity',()=>{
 const b=table([[internal('a',10),Buffer.from('new')],[internal('b',11,0),Buffer.alloc(0)]]);const entries=decodeTable(b);assert.equal(entries[0].sequence,10n);assert.equal(entries[1].value,null);b[10]^=1;assert.throws(()=>decodeTable(b),/checksum/i);
});
test('manifest live file selection prevents obsolete table resurrection and scanner returns cumulative usage',t=>{
 const root=temp(t),db=path.join(root,'IndexedDB','https_claude.ai_0.indexeddb.leveldb');fs.mkdirSync(db,{recursive:true});fs.writeFileSync(path.join(db,'CURRENT'),'MANIFEST-000001\n');fs.writeFileSync(path.join(db,'MANIFEST-000001'),manifest(3,[2,4],[4]));
 fs.writeFileSync(path.join(db,'000002.ldb'),table([[internal(idbKey(),2),value(tree([result(1,3)]))]]));fs.writeFileSync(path.join(db,'000004.ldb'),table([[internal(idbKey(),999),value(tree([result(1,999)]))]]));fs.writeFileSync(path.join(db,'000003.log'),wal([batch(4,[[idbKey(),value(tree([result(1,3),result(2,5)]))]])]));
 const out=scanCoworkCache({roots:[root]});assert.deepEqual(out.warnings,[]);assert.equal(out.sessions.length,1);assert.equal(out.sessions[0].costState.totalCostUSD,0.5);assert.equal(out.sessions[0].sessionId,sid);
 assert.deepEqual([...decodeManifest(manifest(3,[2,4],[4])).tables],[2]);
});
test('Chromium idb_cmp1 manifest comparator is supported without relying on key ordering',()=>{
 assert.equal(decodeManifest(wal([Buffer.concat([vi(1),str('idb_cmp1'),vi(2),vi(3)])])).logNumber,3);
});
test('discovery includes non-MSIX Windows and macOS roots without reading arbitrary app data',()=>{
 assert.ok(discoverCoworkRoots({platform:'win32',env:{APPDATA:'C:/Roaming',LOCALAPPDATA:'C:/Local'},home:'C:/Users/u'}).some(p=>p.replace(/\\/g,'/').endsWith('Roaming/Claude')));
 assert.ok(discoverCoworkRoots({platform:'darwin',env:{},home:'/Users/u'}).includes('/Users/u/Library/Application Support/Claude'));
});
test('activity cutoff uses session timestamps, not a shared hot cache file',()=>{
 const sessions=normalizeCoworkRecords([{object:tree([result(1,5)]),sequence:1n}],{mtimeMs:Date.parse('2026-03-01T00:00:00Z'),size:3});
 assert.equal(sessions[0].mtimeMs,Date.parse('2026-01-01T00:00:00Z'));
});
function snappyLiteral(b) { const n=b.length-1;let tag;if(n<60)tag=Buffer.from([n<<2]);else { const width=n<=255?1:n<=65535?2:3;tag=Buffer.alloc(1+width);tag[0]=(59+width)<<2;for(let i=0;i<width;i++)tag[i+1]=(n>>>8*i)&255; }return Buffer.concat([vi(b.length),tag,b]); }
test('compressed Blink v21 and V8 v16 plain objects decode without rewriting wire versions',()=>{
 const raw=v8.serialize({answer:42});raw[1]=16;
 const frame=Buffer.concat([Buffer.from([255,21,254]),Buffer.alloc(12),raw]);
 const indexed=Buffer.concat([vi(1),Buffer.from([255,17,2]),snappyLiteral(frame)]);
 assert.deepEqual(decodeIndexedValue(indexed),{answer:42});
 const bad=Buffer.from(indexed);bad[bad.length-1]=255;assert.throws(()=>decodeIndexedValue(bad));
 assert.throws(()=>decodeIndexedValue(Buffer.concat([vi(1),Buffer.from([255,17,2]),vi(100000000)])),/limit/i);
});
test('latest table deletion suppresses an older WAL value and does not leak deleted sessions',t=>{
 const root=temp(t),db=path.join(root,'IndexedDB','https_claude.ai_0.indexeddb.leveldb');fs.mkdirSync(db,{recursive:true});fs.writeFileSync(path.join(db,'CURRENT'),'MANIFEST-000001\n');fs.writeFileSync(path.join(db,'MANIFEST-000001'),manifest(3,[2]));
 fs.writeFileSync(path.join(db,'000002.ldb'),table([[internal(idbKey(),10,0),Buffer.alloc(0)]]));fs.writeFileSync(path.join(db,'000003.log'),wal([batch(4,[[idbKey(),value(tree([result(1,5)]))]])]));
 const out=scanCoworkCache({roots:[root]});assert.deepEqual(out,{sessions:[],warnings:[]});
});
test('malformed latest cumulative counters fail closed instead of reusing an older snapshot',()=>{
 const bad=result(2,7);bad.payload.total_cost_usd=-1;
 assert.throws(()=>normalizeCoworkRecords([{object:tree([result(1,3),bad]),sequence:1n}],{}),/usage|cost/i);
 const fractional=result(1,3);fractional.payload.modelUsage['model-test'].inputTokens=1.5;
 assert.throws(()=>normalizeCoworkRecords([{object:tree([fractional]),sequence:1n}],{}),/counter/i);
});
test('engine restarts retain separate observed time spans rather than duplicating the whole conversation',()=>{
 const second='22222222-2222-4222-8222-222222222222';const a=result(1,3),b=result(3,2,second);b.payload.created_at='2026-02-01T00:00:00Z';
 const sessions=normalizeCoworkRecords([{object:tree([a,b]),sequence:1n}],{});
 assert.equal(sessions[0].shell.endedAt,'2026-01-01T00:00:00.000Z');assert.equal(sessions[1].shell.startedAt,'2026-02-01T00:00:00.000Z');
});
test('aggregate decoded-byte budget stops compressed cache expansion before allocating output',()=>{
 const raw=v8.serialize({x:'a'.repeat(100)}),indexed=Buffer.concat([vi(1),Buffer.from([255,17,2]),snappyLiteral(raw)]);
 assert.throws(()=>decodeIndexedValue(indexed,{remaining:10}),/budget/i);
});
test('table block expansion consumes an aggregate budget before materializing values',()=>{
 const b=table([[internal('key',1),Buffer.alloc(100)]]);
 assert.throws(()=>decodeTable(b,{remaining:10}),/budget/i);
});
test('live fingerprints detect cache changes and a partial append waits for a complete cumulative snapshot',t=>{
 const root=temp(t),db=path.join(root,'IndexedDB','https_claude.ai_0.indexeddb.leveldb');fs.mkdirSync(db,{recursive:true});
 fs.writeFileSync(path.join(db,'CURRENT'),'MANIFEST-000001\n');fs.writeFileSync(path.join(db,'MANIFEST-000001'),manifest(3,[]));
 const first=wal([batch(1,[[idbKey(),value(tree([result(1,3)]))]])]);const next=wal([batch(2,[[idbKey(),value(tree([result(1,3),result(2,7)]))]])]);const file=path.join(db,'000003.log');fs.writeFileSync(file,first);
 const before=getCoworkCacheFingerprint({roots:[root]});assert.equal(typeof before,'string');assert.equal(getCoworkCacheFingerprint({roots:[root]}),before);
 assert.equal(scanCoworkCache({roots:[root]}).sessions[0].costState.totalCostUSD,0.3);
 fs.appendFileSync(file,next.subarray(0,next.length-1));assert.notEqual(getCoworkCacheFingerprint({roots:[root]}),before);
 const busy=scanCoworkCache({roots:[root]});assert.equal(busy.sessions.length,0);assert.equal(busy.warnings[0].code,'COWORK_CACHE_BUSY');assert.equal(busy.warnings[0].retryable,true);
 fs.appendFileSync(file,next.subarray(next.length-1));const ready=scanCoworkCache({roots:[root]});assert.deepEqual(ready.warnings,[]);assert.equal(ready.sessions[0].costState.totalCostUSD,0.7);
});
test('live normalization does not add partial assistant usage before its completed result',()=>{
 const partial={seq:2,payload:{type:'assistant',session_id:sid,created_at:'2026-01-01T00:00:02Z',message:{id:'msg1',usage:{input_tokens:999,output_tokens:999},content:[]}}};
 const first=normalizeCoworkRecords([{object:tree([partial]),sequence:1n}],{});assert.deepEqual(first,[]);
 const running=normalizeCoworkRecords([{object:tree([result(1,3),partial]),sequence:2n}],{});assert.equal(running[0].costState.modelUsage['model-test'].inputTokens,3);
 const completed=normalizeCoworkRecords([{object:tree([result(1,3),partial,result(3,7)]),sequence:3n}],{});assert.equal(completed[0].costState.modelUsage['model-test'].inputTokens,7);
});
test('cache fingerprint tracks manifest rollover and table creation but absent roots return null',t=>{
 const root=temp(t);assert.equal(getCoworkCacheFingerprint({roots:[root]}),null);
 const db=path.join(root,'IndexedDB','https_claude.ai_0.indexeddb.leveldb');fs.mkdirSync(db,{recursive:true});fs.writeFileSync(path.join(db,'CURRENT'),'MANIFEST-000001\n');fs.writeFileSync(path.join(db,'MANIFEST-000001'),manifest(3,[]));
 const a=getCoworkCacheFingerprint({roots:[root]});fs.writeFileSync(path.join(db,'MANIFEST-000002'),manifest(3,[]));fs.writeFileSync(path.join(db,'CURRENT'),'MANIFEST-000002\n');
 const b=getCoworkCacheFingerprint({roots:[root]});assert.notEqual(a,b);fs.writeFileSync(path.join(db,'000004.ldb'),Buffer.from('table placeholder'));assert.notEqual(getCoworkCacheFingerprint({roots:[root]}),b);
});
