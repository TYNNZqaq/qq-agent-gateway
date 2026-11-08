import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateConfiguration } from '../packages/core/configuration.mjs';
import { digest } from '../packages/core/contracts.mjs';

// Fixed synthetic example, no private path mapping, database, login or transport.
try {
  const file=new URL('../docs/g1/config.synthetic.json',import.meta.url);
  const config=validateConfiguration(JSON.parse(readFileSync(fileURLToPath(file),'utf8')));
  console.log(JSON.stringify({passed:true,schemaVersion:config.schemaVersion,contractVersion:config.contractVersion,bots:config.bots.length,agents:config.agents.length,bindings:config.bindings.length,executionEnabled:config.executionEnabled,configurationSha256:digest(JSON.stringify(config))},null,2));
} catch(error) {
  console.error(JSON.stringify({passed:false,code:error.code||'CONFIGURATION_INVALID'}));process.exitCode=1;
}
