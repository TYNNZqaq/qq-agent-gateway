import { request as httpsRequest } from 'node:https';
import { ManagementError } from '../core/management.mjs';

// Fixed routes reviewed against Tencent's official BotGo token and Me implementations.
export const QQ_PLATFORM_ROUTES=Object.freeze({token:'https://bots.qq.com/app/getAppAccessToken',sandbox:'https://sandbox.api.sgroup.qq.com/users/@me',production:'https://api.sgroup.qq.com/users/@me'});
const error=(code='QQ_PLATFORM_OUTCOME_UNKNOWN')=>new ManagementError(code,409);
export function createQQPlatformClient({request=httpsRequest,now=()=>Date.now(),timeoutMs=10000}={}){
  const jsonRequest=(url,method,headers,body,signal)=>new Promise((resolve,reject)=>{
    let completed=false,req,timer;
    const finish=(err,value)=>{if(completed)return;completed=true;clearTimeout(timer);err?reject(err):resolve(value);};
    try{req=request(url,{method,headers,agent:false,rejectUnauthorized:true,minVersion:'TLSv1.2',signal},res=>{
      let chunks=[],size=0;
      if(res.statusCode>=300&&res.statusCode<400){res.resume();finish(error('QQ_PLATFORM_REDIRECT_FORBIDDEN'));return;}
      res.on('data',chunk=>{size+=chunk.length;if(size>16384){req.destroy();finish(error('QQ_PLATFORM_RESPONSE_INVALID'));}else chunks.push(chunk);});
      res.on('error',()=>finish(error()));res.on('aborted',()=>finish(error()));
      res.on('end',()=>{
        if(res.statusCode===401||res.statusCode===403){finish(error('QQ_PLATFORM_AUTHENTICATION_FAILED'));return;}
        if(res.statusCode!==200){finish(error());return;}
        try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();finish(null,value);}catch{finish(error('QQ_PLATFORM_RESPONSE_INVALID'));}
      });
    });}catch{finish(error());return;}
    timer=setTimeout(()=>{req.destroy();finish(error());},timeoutMs);
    req.on('error',()=>finish(error()));req.end(body);
  });
  return {verifyIdentity:async({appId,clientSecret,environment,signal,guard=()=>{}})=>{
    if(typeof appId!=='string'||!/^\d{1,30}$/.test(appId)||/\s/.test(appId)||typeof clientSecret!=='string'||!['sandbox','production'].includes(environment))throw error('QQ_PLATFORM_INPUT_INVALID');
    guard();if(signal.aborted)throw error();
    const body=JSON.stringify({appId,clientSecret}),token=await jsonRequest(QQ_PLATFORM_ROUTES.token,'POST',{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},body,signal);
    guard();if(signal.aborted)throw error();
    if(token.code!==undefined&&token.code!==0)throw error('QQ_PLATFORM_AUTHENTICATION_FAILED');
    const ttl=Number(token.expires_in);
    if(typeof token.access_token!=='string'||!token.access_token.length||token.access_token.length>4096||/[\x00-\x20\x7f]/.test(token.access_token)||!['number','string'].includes(typeof token.expires_in)||!Number.isInteger(ttl)||ttl<=0||ttl>86400)throw error('QQ_PLATFORM_RESPONSE_INVALID');
    const expiresAt=now()+ttl*1000;
    const profile=await jsonRequest(QQ_PLATFORM_ROUTES[environment],'GET',{'Authorization':'QQBot '+token.access_token,'X-Union-Appid':appId},undefined,signal);
    guard();if(signal.aborted)throw error();
    if(profile.bot!==true||typeof profile.id!=='string'||!profile.id.length||profile.id.length>128||/[\x00-\x20\x7f]/.test(profile.id)||now()>=expiresAt)throw error('QQ_PLATFORM_IDENTITY_INVALID');
    // Bot user ID is not AppID. The credential exchange binds AppID; profile pins the bot identity.
    return {platformUserId:profile.id,expiresAt,trustBasis:'official_app_credentials_and_authenticated_bot_profile'};
  }};
}
