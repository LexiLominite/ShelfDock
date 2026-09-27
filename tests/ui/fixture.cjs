'use strict';
// Every value is fictional. This bridge cannot access the native clipboard or SSH.
module.exports = function installFixture({ mode = 'expanded', entries = 35, hosts = 12 } = {}) {
  const clone = value => structuredClone(value);
  const now = '2026-09-28T09:30:00.000Z';
  window.__calls = []; window.__listeners = {};
  window.__state = {hosts: Array.from({length:hosts}, (_,i) => ({id:`host-${i}`,name:['Studio','Work laptop','Render node','Design server'][i%4]+(i>3?` ${i+1}`:''),address:`machine-${i}.example.test`,user:'demo',port:22,destination:'~/Desktop',route:i%3===0?'tailscale':i%3===1?'lan':'ssh',source:i%2?'SSH':'Wave',status:i%5===4?'offline':i%5===3?'auth-required':'ready',os:'posix'})),items:[{id:'item-1',name:'Release notes.txt',kind:'text',preview:'Review the release notes before sharing.',size:460},{id:'item-2',name:'Interface studies.pdf',kind:'file',path:'/fictional/Interface studies.pdf',size:245600}],history:[{id:'receipt-1',hostId:'host-0',hostName:'Studio',itemCount:1,itemIds:['item-1'],status:'sent',timestamp:now,destination:'~/Desktop/Transfer'}],settings:{viewMode:mode,shakeEnabled:true,sensitivity:'strong'},discovery:{warnings:[]},environment:{sshAvailable:true,shortcutAvailable:true,passwordStorageAvailable:true}};
  const titles=['Project handoff notes','https://example.com/review','Meeting follow-up','Launch checklist','Design tokens','A useful snippet'];
  window.__clips = {entries:Array.from({length:entries},(_,i)=>({id:`clip-${i}`,kind:'text',title:titles[i%titles.length]+(i>5?` ${i+1}`:''),preview:i%2?'Keep the useful details close at hand.':'A note for the next release. Review, copy, or send when ready.',size:170+i,pinned:i%6===0,createdAt:now})),settings:{enabled:true,paused:false,maxItems:200,retentionDays:30},available:true};
  window.__tunnels={active:[],history:[]};
  const emitState=()=>window.__listeners.state?.(clone(window.__state));
  const emitTunnels=()=>window.__listeners.tunnels?.(clone(window.__tunnels));
  const call=(method,fn=()=>clone(window.__state))=>async value=>{window.__calls.push({method,value});return fn(value);};
  const subscribe=key=>fn=>{window.__listeners[key]=fn;return()=>{delete window.__listeners[key];};};
  window.__setMode = value => {window.__state.settings.viewMode=value;emitState();};
  window.__publishTunnels=emitTunnels;
  window.__start = async request => {
    const entry={...request,id:`active-${window.__calls.length}`,hostName:window.__state.hosts.find(h=>h.id===request.hostId)?.name,status:'starting',startedAt:now};
    window.__tunnels.active.push(entry);emitTunnels();
    const finish=()=>{
      if(window.__failStart){entry.status='failed';entry.error='This listening port is already in use. Choose another port.';window.__failStart=false;}
      else entry.status='running';
      if(request.remember){const plan={...request,id:`plan-${window.__calls.length}`,hostName:entry.hostName,lastUsedAt:now};window.__tunnels.history.unshift(plan);entry.historyId=plan.id;}
      emitTunnels();return clone(window.__tunnels);
    };
    if(window.__deferStart)return new Promise(resolve=>{window.__finishStart=()=>resolve(finish());window.__finishStale=()=>resolve({active:[{...entry,status:'running'}],history:clone(window.__tunnels.history)});});
    return finish();
  };
  window.drift={productName:'DropHarbor',getState:call('getState'),onState:subscribe('state'),onReveal:()=>()=>{},setInteraction:call('setInteraction',()=>({})),hideWindow:call('hideWindow',()=>({})),
    updateSettings:call('updateSettings',patch=>{Object.assign(window.__state.settings,patch);emitState();return clone(window.__state);}),
    refreshHosts:call('refreshHosts'),probeHosts:call('probeHosts'),saveHost:call('saveHost',host=>{const index=window.__state.hosts.findIndex(h=>h.id===host.id);window.__state.hosts[index]={...host};return clone(window.__state);}),removeHost:call('removeHost',id=>{window.__state.hosts=window.__state.hosts.filter(h=>h.id!==id);return clone(window.__state);}),
    send:call('send'),sendMany:call('sendMany'),captureClipboard:call('captureClipboard'),pickFiles:call('pickFiles'),getFilePath:file=>`/fictional/${file.name}`,
    enqueueText:call('enqueueText',text=>{const item={id:`item-${Date.now()}`,name:text,preview:text,kind:'text',size:text.length};window.__state.items.push(item);return {...clone(window.__state),enqueuedItemIds:[item.id]};}),
    enqueueFiles:call('enqueueFiles',paths=>{const added=paths.map((path,i)=>({id:`file-${i}`,name:path.split('/').at(-1),path,kind:'file'}));window.__state.items.push(...added);return {...clone(window.__state),enqueuedItemIds:added.map(i=>i.id)};}),
    clearItems:call('clearItems',()=>{window.__undo=window.__state.items;window.__state.items=[];window.__state.clearShelfUndo={count:window.__undo.length,expiresAt:new Date(Date.now()+10000).toISOString()};return clone(window.__state);}),
    undoClear:call('undoClear',()=>{window.__state.items.push(...window.__undo);window.__state.clearShelfUndo=null;return {...clone(window.__state),restoredItemIds:window.__undo.map(i=>i.id)};}),removeItem:call('removeItem',id=>{window.__state.items=window.__state.items.filter(i=>i.id!==id);return clone(window.__state);}),
    getClipboardHistory:call('getClipboardHistory',({query='',filter='all'}={})=>({...clone(window.__clips),entries:clone(window.__clips.entries.filter(e=>(filter==='all'||filter==='pinned'&&e.pinned||e.kind===filter)&&(!query||`${e.title} ${e.preview}`.toLowerCase().includes(query.toLowerCase()))))})),
    onClipboardHistory:subscribe('clipboard'),getClipboardEntry:call('getClipboardEntry',id=>({...clone(window.__clips.entries.find(e=>e.id===id)),text:'Full selected note.\n<script>This stays ordinary text.</script>\nKeep files and clipboard actions separate.'})),copyClipboardEntry:call('copyClipboardEntry',()=>({ok:true})),
    setClipboardPinned:call('setClipboardPinned',({id,pinned})=>{window.__clips.entries.find(e=>e.id===id).pinned=pinned;return clone(window.__clips);}),updateClipboardPreferences:call('updateClipboardPreferences',patch=>{Object.assign(window.__clips.settings,patch);return clone(window.__clips);}),removeClipboardEntry:call('removeClipboardEntry',id=>{window.__clips.entries=window.__clips.entries.filter(e=>e.id!==id);return clone(window.__clips);}),clearClipboardHistory:call('clearClipboardHistory',()=>{window.__clips.entries=window.__clips.entries.filter(e=>e.pinned);return clone(window.__clips);}),captureClipboardHistory:call('captureClipboardHistory',()=>clone(window.__clips)),saveClipboardSnippet:call('saveClipboardSnippet',value=>{window.__clips.entries.unshift({id:`snippet-${Date.now()}`,kind:'text',title:value.title||'Snippet',preview:value.text,pinned:true,size:value.text.length,createdAt:now});return clone(window.__clips);}),addClipboardEntryToShelf:call('addClipboardEntryToShelf',id=>{const entry=window.__clips.entries.find(e=>e.id===id);const item={id:'from-clipboard',name:entry.title,kind:'text',preview:entry.preview};window.__state.items.push(item);return {...clone(window.__state),enqueuedItemIds:[item.id]};}),
    getTunnels:call('getTunnels',()=>clone(window.__tunnels)),onTunnels:subscribe('tunnels'),startTunnel:call('startTunnel',window.__start),restartTunnel:call('restartTunnel',id=>window.__start({...window.__tunnels.history.find(p=>p.id===id),remember:true})),stopTunnel:call('stopTunnel',id=>{window.__tunnels.active=window.__tunnels.active.filter(e=>e.id!==id);emitTunnels();return clone(window.__tunnels);}),openTunnelSite:call('openTunnelSite',({id,scheme,path})=>({url:`${scheme}//127.0.0.1:${window.__tunnels.active.find(e=>e.id===id).listenPort}${path}`})),updateTunnelNote:call('updateTunnelNote',({id,note})=>{window.__tunnels.history.find(p=>p.id===id).note=note;return clone(window.__tunnels);}),removeTunnelHistory:call('removeTunnelHistory',id=>{window.__tunnels.history=window.__tunnels.history.filter(p=>p.id!==id);return clone(window.__tunnels);}),
  };
};
