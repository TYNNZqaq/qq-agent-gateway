export class ManagementError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export const fail = (code, status = 400) => { throw new ManagementError(code, status); };
export function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('INVALID_RECORD');
  if (Object.keys(value).some(k => !keys.includes(k))) fail('UNEXPECTED_FIELD');
  return value;
}
export function label(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 60 || /[\x00-\x1f\x7f]/.test(value)) fail('INVALID_NAME');
  return value.trim();
}
export function internalId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) fail('INVALID_ID');
  return value;
}
export function expectedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('REVISION_REQUIRED', 409);
  return value;
}
export function appIdentity(value) {
  if (typeof value !== 'string' || value && !/^\d{1,30}$/.test(value)) fail('INVALID_APP_ID');
  return value;
}
export function configurationStatus(value) {
  if (!['registered', 'paused'].includes(value)) fail('INVALID_STATUS');
  return value;
}
