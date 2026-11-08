import path from 'node:path';
import { opendirSync, lstatSync, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { noLinks, inside, privateFilename, secretText } from './boundaries.mjs';

const relative = { type: 'string', maxLength: 1024 };
export const PROJECT_READ_TOOLS = [
  { type: 'function', name: 'qq_list_directory', description: 'List at most 100 immediate entries of one relative directory in this authorized project; no recursive reads.',
    inputSchema: { type: 'object', properties: { path: relative }, required: ['path'], additionalProperties: false } },
  { type: 'function', name: 'qq_read_file', description: 'Read one requested project text file, at most 200 lines/8000 characters. Credentials, links, binary and outside paths are blocked.',
    inputSchema: { type: 'object', properties: { path: relative, startLine: { type: 'integer', minimum: 1, maximum: 100000 }, maxLines: { type: 'integer', minimum: 1, maximum: 200 } }, required: ['path', 'startLine', 'maxLines'], additionalProperties: false } }
];
const privatePart = name => !['.qq-inputs', '.qq-exports'].includes(name) && privateFilename(name);
export function projectRead(directory, tool, args) {
  if (!PROJECT_READ_TOOLS.some(item => item.name === tool) || !args || Array.isArray(args) || typeof args !== 'object') throw Error('READ_ARGUMENT_INVALID');
  const keys = tool === 'qq_read_file' ? ['path','startLine','maxLines'] : ['path'];
  if (Object.keys(args).some(key => !keys.includes(key)) || typeof args.path !== 'string' || args.path.length > 1024 || path.isAbsolute(args.path)
    || /^[\\/]/.test(args.path) || /[:\x00-\x1f]/.test(args.path)) throw Error('READ_PATH_INVALID');
  const parts = args.path.replaceAll('\\','/').split('/');
  if (parts.some(part => part === '..' || privatePart(part) && part !== '.')) throw Error('READ_PATH_BLOCKED');
  const file = noLinks(path.resolve(directory, args.path || '.'));
  if (!inside(directory, file)) throw Error('READ_OUTSIDE_PROJECT');
  if (tool === 'qq_list_directory') {
    if (!lstatSync(file).isDirectory()) throw Error('READ_NOT_DIRECTORY');
    const entries = [];
    const handle = opendirSync(file);
    try {
      for (let scanned = 0; scanned < 2000; scanned++) {
        const entry = handle.readSync(); if (!entry) break;
        if (privatePart(entry.name) || entry.isSymbolicLink()) continue;
        const stat = lstatSync(path.join(file, entry.name));
        if (stat.isFile() && stat.nlink !== 1) continue;
        entries.push({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' });
        if (entries.length === 100) break;
      }
    } finally { handle.closeSync(); }
    return { path: args.path || '.', entries, limited: entries.length === 100 };
  }
  if (!Number.isSafeInteger(args.startLine) || args.startLine < 1 || args.startLine > 100000 || !Number.isSafeInteger(args.maxLines) || args.maxLines < 1 || args.maxLines > 200) throw Error('READ_RANGE_INVALID');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 512 * 1024) throw Error('READ_FILE_BLOCKED');
  const descriptor = openSync(file, 'r'); let bytes;
  try {
    const opened = fstatSync(descriptor);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size || opened.nlink !== 1) throw Error('READ_CHANGED');
    const buffer = Buffer.alloc(stat.size + 1); let count = 0, size;
    while (count < buffer.length && (size = readSync(descriptor, buffer, count, buffer.length - count, null)) > 0) count += size;
    if (count !== stat.size) throw Error('READ_CHANGED');
    bytes = buffer.subarray(0, count);
    const after = fstatSync(descriptor);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || noLinks(file) !== file || lstatSync(file).ino !== stat.ino) throw Error('READ_CHANGED');
  } finally { closeSync(descriptor); }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\0') || secretText(text)) throw Error('READ_PRIVATE_OR_BINARY');
  const lines = text.split(/\r?\n/), selected = lines.slice(args.startLine - 1, args.startLine - 1 + args.maxLines).join('\n');
  return { path: args.path, startLine: args.startLine, totalLines: lines.length, content: selected.slice(0,8000), limited: selected.length > 8000 || args.startLine - 1 + args.maxLines < lines.length };
}
