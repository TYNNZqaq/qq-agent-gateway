import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {runtimeEnvironment} from '../packages/application/app-server-rpc.mjs';
test('plugin child PATH retains public tools and excludes desktop private shells, dependencies and temporary shims',()=>{
 const privatePaths=['synthetic/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell','synthetic/.codex/tmp/arg0','synthetic/OpenAI/Codex/runtimes/private-node/bin'],publicPaths=['synthetic/windows/system32','synthetic/windows/WindowsPowerShell/v1.0','synthetic/public-node','synthetic/public-git'];
 const environment=runtimeEnvironment(path.join(process.env.QQ_TEST_ROOT,'synthetic-own-home'),{Path:[...privatePaths,...publicPaths].join(path.delimiter),OPENAI_API_KEY:'must-not-inherit'});
 assert.equal(environment.Path,publicPaths.join(path.delimiter));assert.equal(environment.OPENAI_API_KEY,undefined);
});
