import {createReadStream,lstatSync} from 'node:fs';
import {createZstdDecompress} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// Large history is streamed in a system Node helper. Memory and each returned
// slice stay bounded; no decompressed transcript is written to disk.
export function nativeArchiveSlice(file,offset=null,{headOnly=false}={}){
 const environment=Object.fromEntries(Object.entries(process.env).filter(([k])=>['SYSTEMROOT','WINDIR','SYSTEMDRIVE','TEMP','TMP'].includes(k.toUpperCase())));
 const result=spawnSync(process.execPath,[fileURLToPath(import.meta.url),file,String(offset??-1),headOnly?'head':'slice'],{env:environment,windowsHide:true,shell:false,encoding:'utf8',timeout:8000,maxBuffer:8*1024*1024});
 if(result.status!==0)throw Error(result.error?.code==='ETIMEDOUT'?'DESKTOP_ARCHIVE_TIMEOUT':'DESKTOP_ARCHIVE_LIMIT');
 try{const data=JSON.parse(result.stdout);return {...data,head:Buffer.from(data.head,'base64'),bytes:Buffer.from(data.bytes,'base64')};}catch{throw Error('DESKTOP_ARCHIVE_INVALID');}
}
async function run(file,offset,headOnly){
 if(!path.isAbsolute(file)||!Number.isSafeInteger(offset)||offset< -1||offset>1024*1024*1024||lstatSync(file).size>256*1024*1024)throw Error('LIMIT');
 const source=createReadStream(file,{highWaterMark:65536}),decoder=createZstdDecompress({chunkSize:65536});source.on('error',e=>decoder.destroy(e));source.pipe(decoder);
 let head=Buffer.alloc(0),from=null,to=null,total=0,more=false;const pieces=[];
 try{for await(const chunk of decoder){const start=total;total+=chunk.length;if(total>1024*1024*1024)throw Error('LIMIT');
   if(from===null){head=Buffer.concat([head,chunk]);const newline=head.indexOf(10);if(newline<0){if(head.length>=1024*1024)throw Error('LIMIT');continue;}head=head.subarray(0,newline+1);from=offset<0?head.length:Math.max(head.length,offset-256);to=from+4*1024*1024+256;
    if(headOnly)break;
   }
   const a=Math.max(from,start),b=Math.min(to,total);if(b>a)pieces.push(chunk.subarray(a-start,b-start));
   if(total>to){more=true;break;}
  }}finally{source.destroy();decoder.destroy();}
 if(from===null)throw Error('INVALID');
 const bytes=Buffer.concat(pieces);return {head:head.toString('base64'),bytes:bytes.toString('base64'),from,size:more?from+bytes.length+1:total,more};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(await run(process.argv[2],Number(process.argv[3]),process.argv[4]==='head')));}catch{process.exitCode=1;}
}
