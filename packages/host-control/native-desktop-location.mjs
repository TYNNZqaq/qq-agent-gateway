import path from 'node:path';
import os from 'node:os';
import {existsSync,lstatSync} from 'node:fs';
import {checkedApplicationPath} from './application-paths.mjs';

const inside=(root,target)=>{const relative=path.relative(root,target);return !relative||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
// Resolve only the current user's declared/default desktop history location.
// Never discover or read another application's credentials or executable tree.
export function nativeDesktopLocation({environment=process.env,home=os.homedir(),privateRoots=[]}={}){
 const declared=environment.QQ_AGENT_DESKTOP_HOME||environment.CODEX_HOME;
 const candidate=declared||path.join(home,'.codex');
 try{
  const directory=checkedApplicationPath(candidate);
  if(directory===path.parse(directory).root||privateRoots.some(root=>inside(path.resolve(root),directory)||inside(directory,path.resolve(root))))return {ready:false,reason:'NATIVE_DESKTOP_HOME_OVERLAP'};
  if(!existsSync(directory)||!lstatSync(directory).isDirectory())return {ready:false,reason:'NATIVE_DESKTOP_HOME_NOT_READY'};
  const sessions=checkedApplicationPath(path.join(directory,'sessions')),index=checkedApplicationPath(path.join(directory,'state_5.sqlite'));
  if(!existsSync(sessions)||!lstatSync(sessions).isDirectory()||!existsSync(index))return {ready:false,reason:'NATIVE_DESKTOP_HOME_NOT_READY'};
  const stat=lstatSync(index);if(!stat.isFile()||stat.nlink!==1)return {ready:false,reason:'NATIVE_DESKTOP_HOME_UNSAFE'};
  return {ready:true,home:directory};
 }catch{return {ready:false,reason:'NATIVE_DESKTOP_HOME_UNSAFE'};}
}
