import path from 'node:path';
import {realpathSync,lstatSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
try{
 const input=process.argv[2];if(!path.isAbsolute(input)||input===path.parse(input).root)throw Error('INVALID_BUSINESS_DIRECTORY');
 const directory=realpathSync.native(input),file=path.join(directory,'state.sqlite');if(lstatSync(file).isSymbolicLink()||lstatSync(file).nlink!==1)throw Error('INVALID_BUSINESS_DATABASE');
 const db=new DatabaseSync(file,{readOnly:true});try{const row=db.prepare('SELECT value FROM settings WHERE key=?').get('owner'),owner=JSON.parse(row.value),identity=JSON.parse(owner);if(!Array.isArray(identity)||identity.length!==3||identity[1]!=='c2c'||!identity[2])throw Error('PAIRED_OWNER_REQUIRED');process.stdout.write(createHash('sha256').update(owner).digest('hex'));}finally{db.close();}
}catch{process.stderr.write('PAIRED_OWNER_REQUIRED\n');process.exitCode=1;}
