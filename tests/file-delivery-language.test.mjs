import test from 'node:test';
import assert from 'node:assert/strict';
import {wantsFiles,fileInstructions} from '../packages/application/files.mjs';

test('explicit Chinese QQ delivery requests activate the same bounded export flow as send requests',()=>{
  for(const prompt of ['生成一个仅含CODEX_QQ_PARITY_OK的txt文件，并通过QQ交付；不要读取其他文件。','把本轮报告交付至ＱＱ','生成文件，经由 QQ 发送']){
    assert.equal(wantsFiles(prompt),true,prompt);assert.match(fileInstructions(prompt),/QQ 文件交付/);
  }
});

test('negated, quoted and feature-only QQ delivery language never grants file transmission',()=>{
  for(const prompt of ['生成文件，但不要通过QQ交付','生成文件，禁止交付到QQ','新增通过QQ交付文件的功能','新增QQ文件交付功能','介绍文件，“通过QQ交付”只是引用','只生成文件，不用通过QQ交付'])assert.equal(wantsFiles(prompt),false,prompt);
});
