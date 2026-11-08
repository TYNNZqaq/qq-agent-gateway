import { createManagementServer } from '../packages/host-control/local-server.mjs';
import { discoverTools } from '../packages/host-control/tool-catalog.mjs';
// Disposable UI QA instance: no filesystem database, credentials, QQ or model calls.
const app=await createManagementServer({database:':memory:',port:17392,mode:'synthetic-preview',tools:discoverTools('',{environment:{PATH:''},readMapping:false})});
console.log(JSON.stringify({url:app.origin,mode:'synthetic-preview'}));
process.on('SIGINT',async()=>{await app.close();process.exit(0);});
