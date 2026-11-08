import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../packages/management-ui/app.js',import.meta.url),'utf8');
async function browser({business={},codexWork={}}={}){
 const nodes=new Map(),listeners=new Map(),calls=[];
 const node=selector=>{if(!nodes.has(selector))nodes.set(selector,{innerHTML:'',textContent:'',value:'',open:false,hidden:false,disabled:false,isConnected:true,classList:{add(){},remove(){},toggle(){}},setAttribute(){},removeAttribute(){},addEventListener(name,fn){listeners.set(selector+':'+name,fn);},showModal(){this.open=true;},close(){this.open=false;listeners.get(selector+':close')?.();},replaceChildren(){this.innerHTML='';}});return nodes.get(selector);};
 const data={revision:3,bots:[],agents:[],bindings:[],tools:[{id:'codex',name:'Codex'}],activity:[],codexAccount:{available:true,revision:1,agentId:null,account:{status:'authenticated',plan:'synthetic'},models:[],selectedModel:'preserved-model',selectionStatus:'selected_unverified'},qqConnection:{available:true,revision:1,state:'authenticated',credentialConfigured:true,identityVerified:true,appIdMasked:'synthetic'},service:{version:'synthetic'},setup:{available:true,revision:1,botId:'synthetic-bot',fresh:false,dataDirectory:'synthetic',privacy:{confirmed:true,text:'synthetic scope'},projects:[],actions:[]},codexWork:{verified:false,reason:'CODEX_PROOF_SOURCE_CHANGED',...codexWork},business:{available:true,configured:true,paired:true,executionConfigured:true,observationOnlyAllowed:true,executionEnabled:false,observationOnly:true,executionBlockedReason:'CODEX_PROOF_SOURCE_CHANGED',running:true,pending:false,serviceFresh:true,processAlive:true,instance:'synthetic-instance',state:'running',qqConnected:true,projects:[],migration:{preserved:true,counts:[]},chatModel:'preserved-chat',workModel:'preserved-work',desktopNotifications:{enabled:true,scope:'all-local',discovered:79,checked:77,controlConnected:false,deliveries:[{status:'sent',count:24}]},...business}};
 const context=vm.createContext({document:{querySelector:node,querySelectorAll:()=>[],addEventListener:(name,fn)=>listeners.set(name,fn),activeElement:{tagName:'BODY'}},history:{replaceState(){}},location:{hash:'#connections',origin:'http://localhost.invalid'},crypto:{randomUUID:()=> 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'},setInterval:()=>0,setTimeout:()=>0,clearTimeout(){},fetch:async(route,options)=>{calls.push({route,options});return {ok:true,json:async()=>route==='/api/bootstrap'?{csrf:'synthetic'}:data};}});
 vm.runInContext(source,context);await new Promise(resolve=>setImmediate(resolve));
 const click=action=>listeners.get('click')({target:{closest:selector=>selector==='[data-action]'?{dataset:{action},disabled:false,isConnected:true}:null},preventDefault(){}});
 return {context,node,calls,click,html:()=>node('#main').innerHTML,mutations:()=>calls.filter(c=>c.options?.method==='POST').map(c=>c.route)};
}

test('online observation mode keeps business controls, saved models and execution reason visible',async()=>{
 const b=await browser();assert.match(b.html(),/data-action="business-stop"/);assert.match(b.html(),/当前为观察模式/);assert.match(b.html(),/QQ 在线 · 观察模式 · 生成待验证/);assert.match(b.html(),/缺少匹配源码的真实隔离证明/);assert.match(b.html(),/聊天、任务生成和新版原生审批暂未开放/);assert.match(b.html(),/已保存的聊天模型：preserved-chat/);assert.match(b.html(),/本机实例已连接（观察模式）/);assert.doesNotMatch(b.html(),/Codex 工作通道已验证|真实执行通过/);assert.deepEqual(b.mutations(),[]);
});
test('stopped configured paired instance with explicit observation fallback restores through business start',async()=>{
 const b=await browser({business:{running:false,qqConnected:false,processAlive:false,serviceFresh:false,state:'stopped'}});assert.doesNotMatch(b.html(),/data-action="business-start" disabled/);await b.click('business-start');assert.deepEqual(b.mutations(),['/api/business/start']);assert.equal(b.calls.some(c=>c.route==='/api/setup/activate'),false);
});
for(const change of [{paired:false},{executionConfigured:false},{observationOnlyAllowed:false},{observationOnlyAllowed:undefined}])test('missing existing-instance startup condition never routes around normal initialization '+JSON.stringify(change),async()=>{
 const b=await browser({business:{running:false,qqConnected:false,processAlive:false,serviceFresh:false,state:'stopped',...change}});assert.match(b.html(),/data-action="business-start" disabled/);await b.click('business-start');assert.deepEqual(b.mutations(),[]);assert.match(b.node('#toast').textContent,/本机初始化中核对/);assert.match(b.html(),/data-action="setup-activate" disabled/);
});
test('current verified execution can restore its configured instance without observation fallback',async()=>{
 const b=await browser({codexWork:{verified:true,reason:null,model:'preserved-model',verifiedAt:new Date().toISOString()},business:{running:false,qqConnected:false,processAlive:false,serviceFresh:false,state:'stopped',observationOnlyAllowed:false,observationOnly:false,executionBlockedReason:null}});await b.click('business-start');assert.deepEqual(b.mutations(),['/api/business/start']);
});
test('stale living process stays unconfirmed, blocks duplicate start and retains the normal stop control',async()=>{
 const b=await browser({business:{running:false,qqConnected:false,serviceFresh:false,state:'stale',lastReportedState:'running',processAlive:true}});assert.match(b.html(),/服务心跳待核对/);assert.match(b.html(),/状态待确认/);assert.match(b.html(),/上次运行使用观察模式/);assert.doesNotMatch(b.html(),/QQ 在线 · 观察模式/);assert.match(b.html(),/data-action="business-start" disabled/);assert.doesNotMatch(b.html(),/data-action="business-stop" disabled/);await b.click('business-start');assert.deepEqual(b.mutations(),[]);await b.click('business-stop');assert.deepEqual(b.mutations(),['/api/business/stop']);
});
test('historical native approval verification never claims the current unverified runtime is open',async()=>{
 const b=await browser({business:{nativeDesktopApprovals:{enabled:true,activation:{verified:true},counts:[{status:'resolved',count:1}]}}});assert.match(b.html(),/历史原生工具审批已有验证记录/);assert.match(b.html(),/新版原生审批转交尚未开放/);assert.doesNotMatch(b.html(),/后续原生请求通过原机器人逐项决定|首次请在 Codex 原生 \/hooks/);
});
test('global observation distinguishes discovered, known and unknown state counts from historical deliveries',async()=>{
 const b=await browser();assert.match(b.html(),/已发现 79 个本机来源；77 个状态已核对；2 个待确认/);assert.match(b.html(),/<progress max="79" value="77" aria-label="本机原生会话状态核对进度">/);assert.match(b.html(),/历史队列累计：已送达 24/);assert.match(b.html(),/来源发现和通知不会授予工作目录读写权限/);assert.match(b.html(),/原生会话控制尚未接通/);assert.doesNotMatch(b.html(),/正在观察已授权的桌面项目/);
});
test('legacy project notifications remain readable without invented global counts or NaN progress',async()=>{
 const b=await browser({business:{desktopNotifications:{enabled:true,deliveries:[]}}});assert.match(b.html(),/桌面项目通知/);assert.match(b.html(),/正在观察已配置的桌面项目/);assert.doesNotMatch(b.html(),/undefined|NaN|<progress/);
});
test('empty or invalid status counts never fabricate determinate progress',async()=>{
 for(const notice of [{enabled:true,scope:'all-local',discovered:0,checked:0},{enabled:true,scope:'all-local',discovered:2,checked:4}]){const b=await browser({business:{desktopNotifications:notice}});assert.doesNotMatch(b.html(),/<progress|NaN|undefined/);}
});
