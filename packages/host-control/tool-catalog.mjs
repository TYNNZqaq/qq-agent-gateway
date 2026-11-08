import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

// Display-only discovery: never starts a Runtime, imports its private code or reads login stores.
const descriptors = [
  {id:'codex',name:'Codex',initials:'C',publisher:'OpenAI',protocol:'App Server',key:'CODEX_EXECUTABLE',command:'codex',description:'代码与项目工作工具'},
  {id:'gemini',name:'Gemini',initials:'G',publisher:'Google',protocol:'ACP',key:'GEMINI_CLI',desktopKey:'GEMINI_DESKTOP',command:'gemini',description:'通用推理与多模态工具'},
  {id:'dsh',name:'DeepSeek Harness',initials:'D',publisher:'DeepSeek',protocol:'待核验',key:'DSH_LAUNCHER',command:'dsh',description:'本机 Agent 运行工具'}
];
export const toolIds=descriptors.map(d=>d.id);
export function discoverTools(runtimeDirectory,{environment=process.env}={}) {
  const isFile=p=>{try{return typeof p==='string' && existsSync(p) && statSync(p).isFile();}catch{return false;}};
  const lookup=name=>(environment.PATH||environment.Path||'').split(path.delimiter).some(dir=>['.exe','.cmd','.bat',''].some(ext=>isFile(path.join(dir,name+ext))));
  return descriptors.map(d=>{
    const cli=d.id==='codex'&&(isFile(environment.CODEX_APP_RUNTIME_CLI_PATH)||lookup(d.command)), desktop=false;
    return {id:d.id,name:d.name,initials:d.initials,publisher:d.publisher,protocol:d.protocol,description:d.description,
      detected:!!(cli||desktop),discovery:cli?'cli':desktop?'desktop':'none',connection:'not_connected',executionEnabled:false};
  });
}
