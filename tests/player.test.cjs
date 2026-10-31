const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {JSDOM, VirtualConsole} = require('jsdom');
const base = require('node:path').join(__dirname, '..') + '/';
const coreText = fs.readFileSync(base + 'core.js', 'utf8');
const contentText = fs.readFileSync(base + 'content.js', 'utf8');
const C = require('../core.js');
const A = 'aaaaaaaaaaa', B = 'bbbbbbbbbbb', D = 'ddddddddddd';
const makeQueue = () => ({items:[{id:A,title:'First'},{id:B,title:'Second'}],index:0,source:'https://www.youtube.com/@test/videos',created:Date.now()});
const clone = value => structuredClone(value);
const flush = async () => { for(let i=0;i<12;i++) await Promise.resolve(); };

async function fixture({url='https://www.youtube.com/@test/videos', queue=null, selected=true, ad=false, markup=null, filters=null}={}) {
  const errors=[];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => { if(!error.message.includes('Not implemented: navigation')) errors.push(error); });
  const card = (id, title) => `<ytd-rich-item-renderer><a id="video-title-link" href="/watch?v=${id}" title="${title}">${title}</a><a id="thumbnail" href="/watch?v=${id}"></a></ytd-rich-item-renderer>`;
  const dom = new JSDOM(`<body><ytd-browse><div id="chips">${filters ?? `<yt-chip-cloud-chip-renderer ${selected?'':'selected'}>新しい順</yt-chip-cloud-chip-renderer><yt-chip-cloud-chip-renderer ${selected?'selected':''}>人気の動画</yt-chip-cloud-chip-renderer><yt-chip-cloud-chip-renderer>古い順</yt-chip-cloud-chip-renderer>`}</div><ytd-rich-grid-renderer>${markup === null ? card(A,'First')+card(A,'Duplicate')+card(B,'Second') : markup}<ytd-rich-shelf-renderer>${card(D,'Shelf')}</ytd-rich-shelf-renderer><div hidden>${card(D,'Hidden')}</div><ytd-rich-item-renderer><a id="thumbnail" href="/shorts/${D}">Short</a></ytd-rich-item-renderer></ytd-rich-grid-renderer></ytd-browse><div id="movie_player" class="${ad?'ad-showing':''}"><video class="html5-main-video"></video></div></body>`, {url,runScripts:'outside-only',virtualConsole});
  const w = dom.window;
  const tasks=new Map(); let time=0,id=0; const now=Date.now();
  w.Date.now=()=>now+time;
  w.setTimeout=(fn,ms=0)=>{const key=++id;tasks.set(key,{fn,at:time+ms});return key;};
  w.clearTimeout=key=>tasks.delete(key);
  w.setInterval=()=>0;
  w.scrollTo=()=>{};
  w.HTMLElement.prototype.scrollIntoView=()=>{};
  const writes=[];
  let stored=clone(queue), clears=0, plays=0;
  w.chrome={runtime:{sendMessage:async message=>{
    if(message.action==='write') {stored=clone(message.queue);writes.push(clone(stored));}
    if(message.action==='clear') {stored=null;clears++;}
    return {ok:true,queue:message.action==='read'?clone(stored):null};
  }}};
  const video=w.document.querySelector('video');
  Object.defineProperty(video,'readyState',{value:2});
  video.play=async()=>{plays++;};
  w.eval(coreText);w.eval(contentText);
  await flush();
  async function tick(ms) {
    const end=time+ms;
    for(let count=0;count<1000;count++) {
      await flush();
      const due=[...tasks].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!due) break;
      time=due[1].at;tasks.delete(due[0]);due[1].fn();
      if(count===999) throw new Error('Timer loop');
    }
    time=end;await flush();
  }
  function click(text) {
    const b=[...w.document.querySelectorAll('button')].find(x=>x.textContent===text || x.getAttribute('aria-label')===text);
    assert.ok(b,`Missing button ${text}`);b.click();
  }
  return {w,dom,video,tick,click,writes,errors,get stored(){return stored},get clears(){return clears},get plays(){return plays}};
}

test('video parsing rejects foreign origins and non-video links',()=>{
  assert.equal(C.videoId(`/watch?v=${A}&list=abc`),A);
  for(const href of [`https://evil.test/watch?v=${A}`,`/shorts/${A}`,'/watch?v=bad','javascript:alert(1)']) assert.equal(C.videoId(href),null);
});
test('channel recognition and popular labels',()=>{
  for(const path of ['/@test/videos','/channel/UC123/videos','/c/test/videos/','/user/test/videos']) assert.equal(C.isChannel(path),true);
  for(const path of ['/watch','/@test/shorts','/feed/subscriptions','/@test']) assert.equal(C.isChannel(path),false);
  for(const label of ['人気の動画','Popular','Most popular','인기순']) assert.equal(C.isPopular(label),true);
  assert.equal(C.isPopular('新しい順'),false);
});
test('normalization preserves rank, removes duplicates and caps queue',()=>{
  assert.deepEqual(C.normalize([{id:B,title:'Top'},{id:A,title:'Next'},{id:B},{id:'bad'}]).map(x=>x.id),[B,A]);
  assert.equal(C.normalize([{id:A,title:'x'.repeat(1000)}])[0].title.length,300);
});
test('queue rejects corruption, expiration and duplicate entries',()=>{
  assert.equal(C.validQueue(makeQueue()),true);
  for(const q of [null,{...makeQueue(),index:-1},{...makeQueue(),index:2},{...makeQueue(),created:0},{...makeQueue(),items:[{id:A,title:'A'},{id:A,title:'B'}]}]) assert.equal(C.validQueue(q),false);
});
test('button appears beside selected popular chip and disappears on sort change',async()=>{
  const f=await fixture();
  assert.equal(f.w.document.querySelector('yt-chip-cloud-chip-renderer[selected]').nextElementSibling.className,'ypp-controls');
  assert.ok(f.w.document.querySelector('.ypp-primary'));
  f.w.document.querySelector('yt-chip-cloud-chip-renderer[selected]').removeAttribute('selected');
  await f.tick(500);
  assert.equal(f.w.document.querySelector('.ypp-controls'),null);
  assert.deepEqual(f.errors,[]);f.dom.window.close();
});
test('no play button on recent, Shorts or home tabs',async()=>{
  for(const options of [{selected:false},{url:'https://www.youtube.com/@test/shorts'},{url:'https://www.youtube.com/@test'}]) {
    const f=await fixture(options);assert.equal(f.w.document.querySelector('.ypp-controls'),null);f.dom.window.close();
  }
});
test('preparation preserves order and excludes shelves, Shorts and hidden cards',async()=>{
  const f=await fixture();f.click('▶ 人気順で再生');
  await f.tick(3000);
  assert.deepEqual(f.stored.items.map(x=>x.id),[A,B]);
  assert.equal(f.stored.index,0);assert.equal(f.writes.length,1);
  assert.deepEqual(f.errors,[]);f.dom.window.close();
});
test('cancel preparation never writes or starts a queue',async()=>{
  const f=await fixture();f.click('▶ 人気順で再生');f.click('キャンセル');await f.tick(1000);
  assert.equal(f.stored,null);assert.equal(f.writes.length,0);assert.equal(f.w.document.querySelector('.ypp-panel'),null);f.dom.window.close();
});
test('start with currently collected videos',async()=>{
  const f=await fixture();f.click('▶ 人気順で再生');f.click('ここまでで再生');await f.tick(700);
  assert.deepEqual(f.stored.items.map(x=>x.id),[A,B]);f.dom.window.close();
});
test('queue restores after navigation and ended advances exactly once',async()=>{
  const f=await fixture({url:`https://www.youtube.com/watch?v=${A}`,queue:makeQueue()});
  assert.match(f.w.document.querySelector('.ypp-panel').textContent,/1 \/ 2/);
  assert.equal(f.plays,1);
  f.video.dispatchEvent(new f.w.Event('ended'));
  f.video.dispatchEvent(new f.w.Event('ended'));
  await flush();
  assert.equal(f.stored.index,1);assert.equal(f.writes.length,1);assert.deepEqual(f.errors,[]);f.dom.window.close();
});
test('an advertisement ending never advances the queue',async()=>{
  const f=await fixture({url:`https://www.youtube.com/watch?v=${A}`,queue:makeQueue(),ad:true});
  f.video.dispatchEvent(new f.w.Event('ended'));await flush();
  assert.equal(f.stored.index,0);assert.equal(f.writes.length,0);assert.equal(f.plays,0);f.dom.window.close();
});
test('manual next and previous persist correct index',async()=>{
  const q=makeQueue();q.index=1;
  const f=await fixture({url:`https://www.youtube.com/watch?v=${B}`,queue:q});
  f.click('前へ');await flush();assert.equal(f.stored.index,0);f.dom.window.close();
});
test('last video finishes and explicit stop clears only the sequence',async()=>{
  const q=makeQueue();q.index=1;
  const f=await fixture({url:`https://www.youtube.com/watch?v=${B}`,queue:q});
  f.video.dispatchEvent(new f.w.Event('ended'));await flush();
  assert.equal(f.stored,null);assert.equal(f.w.document.querySelector('.ypp-panel'),null);
  const g=await fixture({url:`https://www.youtube.com/watch?v=${A}`,queue:makeQueue()});
  g.click('再生リスト');g.click('連続再生を終了');g.click('終了する');await flush();assert.equal(g.stored,null);
  assert.equal(g.w.document.querySelector('.ypp-panel'),null);f.dom.window.close();g.dom.window.close();
});
test('manual navigation and returning to channel cancels restored queue',async()=>{
  for(const url of [`https://www.youtube.com/watch?v=${D}`,'https://www.youtube.com/@test/videos']) {
    const f=await fixture({url,queue:makeQueue()});assert.equal(f.stored,null);assert.equal(f.clears,1);f.dom.window.close();
  }
});
test('SPA navigation cancels preparation and updates button visibility',async()=>{
  const f=await fixture();f.click('▶ 人気順で再生');
  f.w.document.dispatchEvent(new f.w.Event('yt-navigate-start'));
  f.dom.reconfigure({url:'https://www.youtube.com/@test/shorts'});
  f.w.document.dispatchEvent(new f.w.Event('yt-navigate-finish'));
  await f.tick(1000);assert.equal(f.stored,null);assert.equal(f.w.document.querySelector('.ypp-controls'),null);f.dom.window.close();
});

test('service worker stores per tab, survives worker restart, and cleans up',async()=>{
  const store={};let listener,removed;
  const chrome={runtime:{onMessage:{addListener:fn=>listener=fn}},tabs:{onRemoved:{addListener:fn=>removed=fn}},storage:{session:{
    get:async key=>({[key]:clone(store[key])}),set:async data=>Object.assign(store,clone(data)),remove:async key=>{delete store[key];}
  }}};
  function boot(){const context=vm.createContext({chrome,URL,Date,console});context.importScripts=()=>vm.runInContext(coreText,context);vm.runInContext(fs.readFileSync(base+'background.js','utf8'),context);}
  const sender=tab=>({tab:{id:tab},url:'https://www.youtube.com/watch?v='+A,frameId:0});
  const send=(tab,action,queue)=>new Promise(resolve=>listener({type:'popular-player',action,queue},sender(tab),resolve));
  boot();assert.equal((await send(1,'write',makeQueue())).ok,true);
  assert.equal((await send(2,'read')).queue,null);
  boot();assert.equal((await send(1,'read')).queue.items[0].id,A);
  assert.equal((await send(1,'write',{...makeQueue(),index:100})).ok,false);
  await send(1,'clear');assert.equal((await send(1,'read')).queue,null);
  await send(2,'write',makeQueue());removed(2);await flush();assert.equal(store['queue:2'],undefined);
  store['queue:3']={...makeQueue(),created:0};assert.equal((await send(3,'read')).queue,null);assert.equal(store['queue:3'],undefined);
  assert.equal(listener({type:'popular-player',action:'clear'},{...sender(1),url:'https://evil.test/'},()=>assert.fail('foreign sender')),undefined);
  assert.equal(listener({type:'popular-player',action:'clear'},{...sender(1),frameId:1},()=>assert.fail('iframe')),undefined);
});

test('newly loaded videos append in popularity order during preparation',async()=>{
  const f=await fixture();
  const grid=f.w.document.querySelector('ytd-rich-grid-renderer');
  grid.insertAdjacentHTML('beforeend','<ytd-continuation-item-renderer></ytd-continuation-item-renderer>');
  f.click('▶ 人気順で再生');await f.tick(1000);
  grid.insertAdjacentHTML('beforeend',`<ytd-rich-item-renderer><a id="video-title-link" href="/watch?v=${D}" title="Third">Third</a></ytd-rich-item-renderer>`);
  await f.tick(1000);assert.equal(f.stored,null);
  f.click('ここまでで再生');await f.tick(500);
  assert.deepEqual(f.stored.items.map(x=>x.id),[A,B,D]);f.dom.window.close();
});
test('stalled continuation stops waiting and starts the collected queue',async()=>{
  const f=await fixture();
  f.w.document.querySelector('ytd-rich-grid-renderer').insertAdjacentHTML('beforeend','<ytd-continuation-item-renderer></ytd-continuation-item-renderer>');
  f.click('▶ 人気順で再生');await f.tick(7500);
  assert.deepEqual(f.stored.items.map(x=>x.id),[A,B]);f.dom.window.close();
});
test('autoplay rejection gives a usable instruction without dropping queue',async()=>{
  const f=await fixture({url:`https://www.youtube.com/watch?v=${A}`,queue:makeQueue(),ad:true});
  f.video.play=()=>Promise.reject(new Error('Blocked'));
  f.w.document.querySelector('#movie_player').className='';
  f.w.document.dispatchEvent(new f.w.Event('loadeddata'));await f.tick(500);
  assert.match(f.w.document.querySelector('.ypp-toast').textContent,/再生ボタン/);
  assert.equal(f.stored.index,0);assert.deepEqual(f.errors,[]);f.dom.window.close();
});
test('full queue cap retains the most popular entries',()=>{
  const items=Array.from({length:1100},(_,i)=>({id:String(i).padStart(11,'0'),title:String(i)}));
  const result=C.normalize(items);assert.equal(result.length,1000);assert.equal(result[999].title,'999');
});
test('navigation during preparation cannot save a stale channel queue',async()=>{
  const f=await fixture();f.click('▶ 人気順で再生');
  f.dom.reconfigure({url:'https://www.youtube.com/@other/videos'});
  await f.tick(3000);assert.equal(f.stored,null);assert.equal(f.writes.length,0);f.dom.window.close();
});
test('stop wins over a pending manual-next write',async()=>{
  const f=await fixture({url:`https://www.youtube.com/watch?v=${A}`,queue:makeQueue()});
  f.click('再生リスト');f.click('次へ');f.click('連続再生を終了');f.click('終了する');await flush();
  assert.equal(f.stored,null);assert.equal(f.w.document.querySelector('.ypp-panel'),null);f.dom.window.close();
});


test('modern cards without legacy renderer wrappers remain playable',async()=>{
  const markup=`<yt-lockup-view-model><a class="yt-lockup-view-model__content-image" href="/watch?v=${A}"></a><h3><a href="/watch?v=${A}">First modern title</a></h3></yt-lockup-view-model><div class="yt-lockup-view-model-wiz"><a href="/watch?v=${B}"><h3>Second modern title</h3></a></div>`;
  const f=await fixture({markup});
  assert.equal(f.w.document.querySelector('.ypp-primary').disabled,false);
  f.click('▶ 人気順で再生');await f.tick(3000);
  assert.deepEqual(f.stored.items.map(x=>x.id),[A,B]);
  assert.deepEqual(f.stored.items.map(x=>x.title),['First modern title','Second modern title']);
  assert.deepEqual(f.errors,[]);f.dom.window.close();
});
test('an empty grid gives feedback instead of silently disabling the button',async()=>{
  const f=await fixture({markup:''});
  assert.equal(f.w.document.querySelector('.ypp-primary').disabled,false);
  f.click('▶ 人気順で再生');await f.tick(3000);
  assert.equal(f.stored,null);
  assert.match(f.w.document.querySelector('.ypp-toast').textContent,/動画.*取得/);
  f.dom.window.close();
});
test('extension button click does not bubble into YouTube sort handlers',async()=>{
  const f=await fixture();let nativeClicks=0;
  f.w.document.querySelector('#chips').addEventListener('click',()=>{
    nativeClicks++;f.w.document.dispatchEvent(new f.w.Event('yt-navigate-start'));
  });
  f.click('▶ 人気順で再生');await f.tick(3000);
  assert.equal(nativeClicks,0);assert.deepEqual(f.stored.items.map(x=>x.id),[A,B]);f.dom.window.close();
});


test('dropdown sorting alongside public and members filters gets a play button',async()=>{
  const f=await fixture({filters:`<yt-chip-cloud-chip-renderer><button aria-haspopup="menu">人気の動画<svg></svg></button></yt-chip-cloud-chip-renderer><yt-chip-cloud-chip-renderer>メンバー限定</yt-chip-cloud-chip-renderer><yt-chip-cloud-chip-renderer selected>公開</yt-chip-cloud-chip-renderer>`});
  assert.equal(f.w.document.querySelector('#chips').children[1].className,'ypp-controls');
  assert.equal(f.w.document.querySelector('.ypp-primary').disabled,false);
  f.click('▶ 人気順で再生');await f.tick(3000);
  assert.deepEqual(f.stored.items.map(x=>x.id),[A,B]);f.dom.window.close();
});
test('a dropdown chip need not have a selected or aria-haspopup attribute',async()=>{
  const f=await fixture({filters:`<yt-chip-cloud-chip-renderer>人気の動画<svg></svg></yt-chip-cloud-chip-renderer><yt-chip-cloud-chip-renderer selected>公開</yt-chip-cloud-chip-renderer>`});
  assert.ok(f.w.document.querySelector('.ypp-primary'));f.click('▶ 人気順で再生');await f.tick(3000);
  assert.deepEqual(f.stored.items.map(x=>x.id),[A,B]);f.dom.window.close();
});
test('standalone sort menu button is supported and removed when sort changes',async()=>{
  const f=await fixture({filters:'<button aria-haspopup="listbox">人気の動画 ▾</button><button>メンバー限定</button><button aria-pressed="true">公開</button>'});
  assert.ok(f.w.document.querySelector('.ypp-primary'));
  f.w.document.querySelector('#chips > button').textContent='新しい順 ▾';await f.tick(500);
  assert.equal(f.w.document.querySelector('.ypp-primary'),null);f.dom.window.close();
});
test('submenu renderer without a selected attribute is supported',async()=>{
  const f=await fixture({filters:'<ytd-sort-filter-sub-menu-renderer><button>人気の動画</button></ytd-sort-filter-sub-menu-renderer>'});
  assert.ok(f.w.document.querySelector('.ypp-primary'));f.dom.window.close();
});
test('an open menu option is not mistaken for the currently active sort',async()=>{
  const f=await fixture({filters:'<button aria-haspopup="menu">新しい順</button><div role="menu"><button role="menuitem">人気の動画</button></div>'});
  assert.equal(f.w.document.querySelector('.ypp-primary'),null);f.dom.window.close();
});

test('player shows the saved next video rather than a YouTube recommendation',async()=>{
  const f=await fixture({url:`https://www.youtube.com/watch?v=${A}`,queue:makeQueue()});
  assert.equal(f.w.document.querySelector('.ypp-next').textContent,'次に再生：Second');
  assert.equal(f.w.document.querySelector('.ypp-list-toggle').getAttribute('aria-expanded'),'false');
  assert.equal(f.w.document.querySelector('#ypp-queue-list').hidden,true);
  assert.equal(f.writes.length,0);assert.deepEqual(f.errors,[]);f.dom.window.close();
});
test('opening the full queue preserves rank and identifies current and next',async()=>{
  const q=makeQueue();q.items.push({id:D,title:'Third'});
  const f=await fixture({url:`https://www.youtube.com/watch?v=${A}`,queue:q});
  f.click('再生リスト');
  const rows=[...f.w.document.querySelectorAll('.ypp-queue-item')];
  assert.deepEqual(rows.map(x=>x.getAttribute('aria-label')),['1. First（再生中）','2. Second（次に再生）','3. Third']);
  assert.equal(rows[0].getAttribute('aria-current'),'true');assert.equal(rows[0].disabled,true);
  assert.equal(f.w.document.querySelector('.ypp-list-toggle').getAttribute('aria-expanded'),'true');
  assert.equal(f.w.document.querySelector('#ypp-queue-list').hidden,false);
  f.click('一覧を閉じる');assert.equal(f.w.document.querySelector('#ypp-queue-list').hidden,true);
  assert.equal(f.writes.length,0);assert.equal(f.stored.index,0);f.dom.window.close();
});
test('selecting a later queue entry starts that saved index',async()=>{
  const q=makeQueue();q.items.push({id:D,title:'Third'});
  const f=await fixture({url:`https://www.youtube.com/watch?v=${A}`,queue:q});
  f.click('再生リスト');f.w.document.querySelectorAll('.ypp-queue-item')[2].click();await flush();
  assert.equal(f.stored.index,2);assert.equal(f.stored.items[2].id,D);assert.equal(f.writes.length,1);
  assert.deepEqual(f.stored.items.map(x=>x.id),[A,B,D]);f.dom.window.close();
});
test('a previously played queue entry can be selected',async()=>{
  const q=makeQueue();q.index=1;
  const f=await fixture({url:`https://www.youtube.com/watch?v=${B}`,queue:q});
  f.click('再生リスト');f.w.document.querySelectorAll('.ypp-queue-item')[0].click();await flush();
  assert.equal(f.stored.index,0);assert.equal(f.stored.items[0].id,A);f.dom.window.close();
});
test('last video explicitly indicates no further queue item',async()=>{
  const q=makeQueue();q.index=1;
  const f=await fixture({url:`https://www.youtube.com/watch?v=${B}`,queue:q});
  assert.equal(f.w.document.querySelector('.ypp-next').textContent,'次に再生：なし（最後の動画）');
  f.click('再生リスト');assert.equal(f.w.document.querySelectorAll('.ypp-queue-item')[1].disabled,true);f.dom.window.close();
});
test('Escape closes the queue and returns focus to its toggle',async()=>{
  const f=await fixture({url:`https://www.youtube.com/watch?v=${A}`,queue:makeQueue()});
  f.click('再生リスト');const item=f.w.document.querySelectorAll('.ypp-queue-item')[1];item.focus();
  item.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  const toggle=f.w.document.querySelector('.ypp-list-toggle');
  assert.equal(toggle.getAttribute('aria-expanded'),'false');assert.equal(f.w.document.activeElement,toggle);
  assert.equal(f.writes.length,0);f.dom.window.close();
});
test('queue titles are plain text and cannot inject page content',async()=>{
  const q=makeQueue();q.items[1].title='<img src=x onerror="alert(1)">';
  const f=await fixture({url:`https://www.youtube.com/watch?v=${A}`,queue:q});
  f.click('再生リスト');assert.equal(f.w.document.querySelector('.ypp-panel img'),null);
  assert.match(f.w.document.querySelector('.ypp-next').textContent,/<img/);
  assert.match(f.w.document.querySelectorAll('.ypp-queue-item')[1].textContent,/<img/);f.dom.window.close();
});
test('stopping playback removes the expanded queue as well as the panel',async()=>{
  const f=await fixture({url:`https://www.youtube.com/watch?v=${A}`,queue:makeQueue()});
  f.click('再生リスト');f.click('連続再生を終了');f.click('終了する');await flush();
  assert.equal(f.w.document.querySelector('#ypp-queue-list'),null);assert.equal(f.stored,null);f.dom.window.close();
});


test('stop confirmation can be cancelled without losing the queue',async()=>{
 const f=await fixture({url:`https://www.youtube.com/watch?v=${A}`,queue:makeQueue()});
 f.click('連続再生を終了');assert.ok(f.w.document.querySelector('[role=alertdialog]'));assert.equal(f.stored.index,0);
 f.click('続ける');assert.equal(f.w.document.querySelector('[role=alertdialog]'),null);assert.equal(f.stored.index,0);f.dom.window.close();
});
test('playlist is above banner and toggle changes appearance',async()=>{
 const f=await fixture({url:`https://www.youtube.com/watch?v=${A}`,queue:makeQueue()});
 const before=f.w.document.querySelector('.ypp-list-toggle path').getAttribute('d');
 f.click('再生リスト');const panel=f.w.document.querySelector('.ypp-player');
 assert.equal(panel.firstElementChild.id,'ypp-queue-list');assert.equal(f.w.document.querySelector('input[type=search]'),null);
 assert.notEqual(f.w.document.querySelector('.ypp-list-toggle path').getAttribute('d'),before);f.dom.window.close();
});
test('preparation starts automatically without a second play button',async()=>{
 const f=await fixture();f.click('▶ 人気順で再生');await f.tick(2500);
 assert.ok(f.stored);assert.equal(f.w.document.querySelector('[aria-label="最初の動画を再生"]'),null);
 await f.tick(1500);assert.equal(f.stored.index,0);assert.deepEqual(f.errors,[]);f.dom.window.close();
});
