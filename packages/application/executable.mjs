import {existsSync,lstatSync,realpathSync} from 'node:fs';
import path from 'node:path';
export function resolveCodexExecutable(configured,{environment=process.env,platform=process.platform}={}) {
 if(typeof configured!=='string'||!configured.trim()||/[\x00-\x1f]/.test(configured))throw Error('CODEX_EXECUTABLE_INVALID');
 const command=/^codex(?:\.exe)?$/i.test(configured);
 if(!command&&!path.isAbsolute(configured))throw Error('CODEX_EXECUTABLE_INVALID');
 const candidates=[...(path.isAbsolute(configured)?[configured]:[]),...(command?[environment.CODEX_APP_RUNTIME_CLI_PATH,...String(environment.PATH||environment.Path||'').split(path.delimiter).filter(Boolean).map(p=>path.join(p.replace(/^"|"$/g,''),platform==='win32'?'codex.exe':'codex'))]:[])];
 for(const file of candidates){if(!file||!path.isAbsolute(file)||!existsSync(file))continue;let linked=false;for(let p=file;;p=path.dirname(p)){if(existsSync(p)&&lstatSync(p).isSymbolicLink()){linked=true;break;}if(p===path.dirname(p))break;}if(!linked&&lstatSync(file).isFile())return realpathSync(file);}
 throw Error('CODEX_EXECUTABLE_NOT_FOUND');
}
