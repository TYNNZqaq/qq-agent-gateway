import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../packages/management-ui/app.js',import.meta.url),'utf8');
const tools=['codex','gemini','dsh'].map(id=>({id,name:id==='codex'?'Codex':id==='gemini'?'Gemini':'DeepSeek Harness',initials:id[0],protocol:'synthetic',publisher:'synthetic',description:'synthetic',detected:true,discovery:'cli',connection:'not_connected'}));
async function browser(view='overview',overrides={}){
 const nodes=new Map(),timers=[],calls=[],activeElement={tagName:'BODY'},data={revision:3,bots:[{id:'own-bot',name:'Synthetic bot',status:'registered'}],agents:[{id:'own-agent',name:'Synthetic own Codex',toolId:'codex',status:'registered'}],bindings:[{botId:'own-bot',agentId:'own-agent'}],tools,activity:[],codexAccount:{available:true,revision:1,agentId:'own-agent',account:{status:'authenticated'},models:[],selectedModel:'synthetic-model'},codexWork:{verified:true,model:'synthetic-model'},qqConnection:{available:false},business:{available:true,configured:true,running:true,qqConnected:true,projects:[]},...overrides};
 const node=selector=>{if(!nodes.has(selector))nodes.set(selector,{innerHTML:'',textContent:'',open:false,hidden:false,value:'',classList:{add(){},remove(){},toggle(){}},setAttribute(){},removeAttribute(){},addEventListener(){},replaceChildren(){this.innerHTML='';},showModal(){this.open=true;},close(){this.open=false;}});return nodes.get(selector);};
 let fail=false,hold=null;
 const context=vm.createContext({document:{querySelector:node,querySelectorAll:()=>[],addEventListener(){},activeElement},history:{replaceState(){}},location:{hash:'#'+view,origin:'http://localhost.invalid'},crypto:{randomUUID:()=> 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'},setInterval:(fn,ms)=>{timers.push({fn,ms});return timers.length;},setTimeout:()=>0,clearTimeout(){},fetch:async(route,options)=>{calls.push({route,options});if(fail)throw Error('synthetic management outage');if(hold&&route==='/api/state')await hold;return {ok:true,json:async()=>structuredClone(route==='/api/bootstrap'?{csrf:'synthetic'}:data)};}});
 vm.runInContext(source,context);await new Promise(resolve=>setImmediate(resolve));assert.equal(timers.length,1);assert.equal(timers[0].ms,5000);
 return {data,context,calls,activeElement,node,html:()=>node('#main').innerHTML,poll:()=>timers[0].fn(),fail(value){fail=value;},hold(value){hold=value;},navigate:page=>vm.runInContext('navigate('+JSON.stringify(page)+')',context)};
}
function card(html,id){return html.split('<article class="tool-card">').slice(1).find(t=>t.includes('data-id="'+id+'"'))?.split('</article>')[0]||'';}
for(const view of ['overview','tools'])test(view+' displays actual verified Codex and online QQ even when discovery still says not_connected',async()=>{
 const b=await browser(view),html=card(b.html(),'codex');assert.match(html,/Codex 已验证 · QQ 在线/);assert.doesNotMatch(html,/未接入|待登录/);assert.match(html,/class="dot "/);assert.equal(b.calls.length,2);assert.ok(b.calls.every(c=>!c.options?.method||c.options.method==='GET'));
});
test('verified Codex and stopped or connecting QQ remain distinct states',async()=>{
 const b=await browser('tools',{business:{available:true,configured:true,running:false,qqConnected:true}});assert.match(card(b.html(),'codex'),/Codex 已验证 · 机器人已停止/);assert.doesNotMatch(card(b.html(),'codex'),/QQ 在线/);b.data.business={available:true,configured:true,running:true,qqConnected:false};await b.poll();assert.match(card(b.html(),'codex'),/Codex 已验证 · QQ 连接中/);
});
test('a signed-in account and selected catalog model cannot claim a verified execution',async()=>{
 const b=await browser('tools',{codexWork:{verified:false,reason:'CODEX_WORK_NOT_VERIFIED'}});assert.match(card(b.html(),'codex'),/账号已登录 · 执行待验证/);assert.doesNotMatch(card(b.html(),'codex'),/Codex 已验证|QQ 在线/);assert.match(card(b.html(),'codex'),/dot offline/);
});
test('CLI discovery without login and an account without model selection do not imply connection',async()=>{
 const b=await browser('tools',{codexAccount:{available:true,account:{status:'not_checked'},models:[]},codexWork:{verified:false,reason:'CODEX_WORK_NOT_VERIFIED'}});assert.match(card(b.html(),'codex'),/已发现 Codex · 待登录/);b.data.codexAccount={available:true,account:{status:'authenticated'},models:[]};await b.poll();assert.match(card(b.html(),'codex'),/账号已登录 · 待选择模型/);
});
test('explicit signout overrides an old acceptance and an active login is shown as pending',async()=>{
 const b=await browser('tools',{codexAccount:{available:true,account:{status:'not_authenticated'},models:[]}});assert.match(card(b.html(),'codex'),/Codex 待登录/);assert.doesNotMatch(card(b.html(),'codex'),/已验证|QQ 在线/);b.data.codexAccount.login={state:'awaiting'};await b.poll();assert.match(card(b.html(),'codex'),/等待完成 Codex 账号登录/);
});
for(const status of ['unknown','forbidden'])test('account '+status+' stays unconfirmed even if a previous proof or service flag is present',async()=>{
 const b=await browser('tools',{codexAccount:{available:true,account:{status},models:[]}});assert.match(card(b.html(),'codex'),/账号状态待核对/);assert.doesNotMatch(card(b.html(),'codex'),/已验证|QQ 在线/);
});
test('invalidated path or source proof cannot be replaced by a stale business codexVerified flag',async()=>{
 const b=await browser('tools',{codexWork:{verified:false,reason:'CODEX_PROOF_SOURCE_CHANGED'},business:{available:true,configured:true,running:true,qqConnected:true,codexVerified:true}});assert.match(card(b.html(),'codex'),/验证需更新/);assert.doesNotMatch(card(b.html(),'codex'),/已验证|QQ 在线/);
});
test('only the currently associated Codex agent inherits the verified runtime status',async()=>{
 const b=await browser('agents',{agents:[{id:'own-agent',name:'Synthetic own Codex',toolId:'codex',status:'registered'},{id:'other-agent',name:'Other Codex',toolId:'codex',status:'registered'}]});const rows=b.html().split('<tr>').slice(2);assert.match(rows[0],/Codex 已验证 · QQ 在线/);assert.match(rows[1],/已登记 · 未关联账号/);assert.doesNotMatch(rows[1],/Codex 已验证|QQ 在线/);assert.doesNotMatch(b.html(),/运行接入将在后续阶段启用|未连接 Runtime/);b.data.agents[0].status='paused';b.data.revision++;await b.poll();assert.match(b.html(),/实例已停用/);
});
test('deferred providers do not inherit Codex status or promise a connection',async()=>{
 const b=await browser('tools');for(const id of ['gemini','dsh']){assert.match(card(b.html(),id),/接入已暂缓/);assert.doesNotMatch(card(b.html(),id),/已验证|QQ 在线|dot "/);}
});
for(const view of ['overview','tools','agents'])test(view+' updates runtime labels on the existing poll without a metadata revision change',async()=>{
 const b=await browser(view,{codexWork:{verified:false,reason:'CODEX_WORK_NOT_VERIFIED'}});assert.doesNotMatch(b.html(),/Codex 已验证 · QQ 在线/);b.data.codexWork={verified:true,model:'synthetic-model'};await b.poll();assert.match(b.html(),/Codex 已验证 · QQ 在线/);assert.equal(b.data.revision,3);assert.equal(b.calls.filter(c=>c.route==='/api/state').length,2);
});
test('typing preserves the current form and deferred refresh occurs after focus leaves it',async()=>{
 const b=await browser('tools',{codexWork:{verified:false,reason:'CODEX_WORK_NOT_VERIFIED'}}),before=b.html();b.activeElement.tagName='INPUT';b.data.codexWork={verified:true,model:'synthetic-model'};await b.poll();assert.equal(b.html(),before);b.activeElement.tagName='BODY';await b.poll();assert.match(b.html(),/Codex 已验证 · QQ 在线/);
});
test('management outages remove stale success labels and recovery refreshes the same state',async()=>{
 const b=await browser('tools');b.fail(true);await b.poll();assert.match(card(b.html(),'codex'),/管理台连接中断 · 状态待核对/);assert.doesNotMatch(card(b.html(),'codex'),/已验证|QQ 在线/);b.fail(false);await b.poll();assert.match(card(b.html(),'codex'),/Codex 已验证 · QQ 在线/);
});
test('an open local dialog pauses polling without creating another timer or request',async()=>{
 const b=await browser('tools'),before=b.calls.length;b.node('#editor-dialog').open=true;await b.poll();assert.equal(b.calls.length,before);
});
test('slow management reads cannot create overlapping background status requests',async()=>{
 const b=await browser('tools');let release;b.hold(new Promise(resolve=>{release=resolve;}));const first=b.poll();await new Promise(resolve=>setImmediate(resolve));const count=b.calls.length;await b.poll();assert.equal(b.calls.length,count);release();await first;
});
