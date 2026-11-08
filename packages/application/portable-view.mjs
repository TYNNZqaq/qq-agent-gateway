import path from 'node:path';
import { completionText } from './completion.mjs';
export function publicText(value, maximum=160) { return completionText(value).replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,maximum); }
export const validThreadId = value => typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
export const sameDirectory = (a,b) => typeof a==='string' && typeof b==='string' && path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
export function readDesktopSnapshot() { throw Error('EXTERNAL_DESKTOP_NOT_AVAILABLE'); }
export function resolveRolloutFile() { throw Error('EXTERNAL_HISTORY_NOT_AVAILABLE'); }
export function readRolloutProgress() { throw Error('EXTERNAL_HISTORY_NOT_AVAILABLE'); }
