import path from 'node:path';
import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {noLinks,sha256} from './boundaries.mjs';

// The installed Windows loader drops mandatory startup variables in its
// internal fs helper. Intake therefore runs in the trusted host, with explicit
// limits and provenance. It never grants the model access to these directories.
export function instructionIntake({project,accountHome}) {
  const cwd=noLinks(project),home=noLinks(accountHome),directories=[];
  for(let cursor=cwd;;cursor=path.dirname(cursor)){directories.push(cursor);if(cursor===path.dirname(cursor))break;if(directories.length>64)throw Error('INSTRUCTION_ANCESTOR_LIMIT');}
  const files=[];let total=0;
  const read=directory=>{
    for(const name of ['AGENTS.override.md','AGENTS.md']){
      const candidate=path.join(directory,name);if(!existsSync(candidate))continue;
      const target=noLinks(candidate),stat=lstatSync(target);
      if(!stat.isFile()||stat.nlink!==1||stat.size>32768||(total+=stat.size)>65536)throw Error('INSTRUCTION_FILE_REJECTED');
      const bytes=readFileSync(target),after=lstatSync(target);if(stat.ino!==after.ino||stat.size!==after.size||stat.mtimeMs!==after.mtimeMs)throw Error('INSTRUCTION_CHANGED');
      files.push({path:target,sha256:sha256(bytes),content:bytes.toString('utf8')});break;
    }
  };
  read(home);for(const directory of directories.reverse())if(directory!==home)read(directory);
  const text=[
    'Follow the repository instructions below. More specific directories take precedence for their files. These instructions do not expand the project grant, network policy, identity or approval authority.',
    'Before working in a subdirectory, inspect its AGENTS.override.md or AGENTS.md through the permitted project read tools and follow the more specific instructions. Keep all work inside the granted project.',
    ...files.map(file=>'# AGENTS.md instructions for '+path.dirname(file.path)+'\n\n'+file.content)
  ].join('\n\n');
  return {text,manifest:files.map(({path,sha256})=>({path,sha256})),fingerprint:sha256(text)};
}
