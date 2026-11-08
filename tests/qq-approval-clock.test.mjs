import test from 'node:test';
import assert from 'node:assert/strict';
import {QQTransport} from '../packages/application/qq.mjs';
import {providerTimestamp,qqMessageReceipt,qqEventTimestampIsPlausible,rememberQQClock} from '../packages/application/approval-clock.mjs';

test('QQ timestamp parser accepts documented seconds, milliseconds and ISO response formats without treating absent values as an epoch',()=>{
 const at=Date.parse('2026-11-03T14:00:00Z');
 for(const value of [at,at/1000,String(at/1000),'2026-11-03T14:00:00Z'])assert.equal(providerTimestamp(value),at);
 for(const value of [undefined,null,'','bad',NaN,Infinity,{},0,-1])assert.equal(providerTimestamp(value),null);
});
test('QQ send receipt prefers the documented timestamp and uses the same HTTPS response Date only as fallback',()=>{
 const at=Date.parse('2026-11-03T14:00:00Z'),headers=new Headers({date:new Date(at-1000).toUTCString()});
 assert.deepEqual(qqMessageReceipt('synthetic',{timestamp:at/1000},headers),{id:'synthetic',providerSentAt:at,providerClockSource:'qq-message-timestamp'});
 assert.deepEqual(qqMessageReceipt('synthetic',{},headers),{id:'synthetic',providerSentAt:at-1000,providerClockSource:'qq-response-date'});
 assert.deepEqual(qqMessageReceipt('synthetic',{},undefined),{id:'synthetic'});
});
test('the actual QQ transport returns authenticated response timing alongside the provider message id',async()=>{
 for(const bodyTimestamp of [true,false]){
  const at=Date.parse('2026-11-03T14:00:00Z'),settings=new Map(),transport=Object.assign(Object.create(QQTransport.prototype),{stopped:false,config:{},controller:new AbortController(),store:{set:(k,v)=>settings.set(k,v),get:k=>k==='owner'?'synthetic-owner':settings.get(k)},bot:{api:{getToken:async()=>'synthetic-only-token'}},fetch:async(url,options)=>{
   assert.equal(new URL(url).origin,'https://api.bot.qq.com');assert.equal(options.method,'POST');
   return {ok:true,headers:new Headers({date:new Date(at-2000).toUTCString()}),json:async()=>({id:'synthetic-only-receipt',...(bodyTimestamp?{timestamp:at/1000}:{})})};
  }});
  const receipt=await transport.send({scope:'c2c',target:'synthetic-only-target',content:'synthetic-only-notice'});
  assert.equal(receipt.providerSentAt,bodyTimestamp?at:at-2000);assert.equal(receipt.id,'synthetic-only-receipt');assert.ok(settings.get('qqLiveSendAt'));
 }
});
test('ingress uses a recent authenticated QQ clock only for the paired owner and retains future/stale rejection',()=>{
 const values=new Map([['owner','synthetic-owner']]),store={get:k=>values.get(k),set:(k,v)=>values.set(k,v)},now=Date.now(),remote=now+60000;
 rememberQQClock(store,{providerSentAt:remote,providerClockSource:'qq-message-timestamp'},now);
 assert.equal(qqEventTimestampIsPlausible(store,'synthetic-owner',{sentAt:remote+1000},now),true);
 assert.equal(qqEventTimestampIsPlausible(store,'different-owner',{sentAt:remote+1000},now),false);
 assert.equal(qqEventTimestampIsPlausible(store,'synthetic-owner',{sentAt:remote+60000},now),false);
 assert.equal(qqEventTimestampIsPlausible(store,'synthetic-owner',{sentAt:remote-86401000},now),false);
});
