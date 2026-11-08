import { SqliteJournal } from '../../packages/storage/sqlite-journal.mjs';

// Independent Node process, synthetic SQLite only. No Runtime/QQ transport.
const [database,channel,label]=process.argv.slice(2);
const journal=new SqliteJournal(database,{hostId:'host-test',agentId:'agent-a',channel});
process.stdout.write('ready\n');process.stdin.setEncoding('utf8');
process.stdin.once('data',()=>{
  try{const won=journal.commit({schemaVersion:1,revision:1,owner:{hostId:'host-test',agentId:'agent-a'},label},0);process.stdout.write(JSON.stringify({won,label})+'\n');}
  finally{journal.close();process.stdin.destroy();}
});
