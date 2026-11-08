import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveProject,projectList} from '../packages/application/projects.mjs';
const store={get:()=>null,set(){}};
test('an explicitly configured project alias resolves to the same project and never creates a new grant',()=>{
 const config={projects:{connection_check:{id:'same-project',grantId:'same-grant',label:'连接验证',aliases:['链接验证'],path:'synthetic-project',mode:'workspace-write',tools:['read','edit']}}};
 const a=resolveProject(store,config,'owner','连接验证'),b=resolveProject(store,config,'owner','链接验证');assert.deepEqual(b,a);assert.equal(b.key,'connection_check');assert.equal(Object.keys(config.projects).length,1);assert.match(projectList(store,config,'owner'),/别名：链接验证/);
});
test('similar words without an explicit alias remain ungranted and ambiguous aliases are refused',()=>{
 const config={projects:{one:{label:'连接验证',aliases:['链接验证'],path:'synthetic-one'},two:{label:'另一个项目',aliases:['链接验证'],path:'synthetic-two'}}};assert.equal(resolveProject(store,config,'owner','链接验证'),null);assert.equal(resolveProject(store,config,'owner','连通验证'),null);assert.equal(resolveProject(store,config,'owner','连接验证').key,'one');
});
