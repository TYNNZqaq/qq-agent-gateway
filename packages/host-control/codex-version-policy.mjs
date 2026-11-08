// Explicit protocol versions reviewed with generated schema and live isolation.
// The legacy fixtures retain their original version and evidence.
export const VERIFIED_CODEX_CLI_VERSIONS = Object.freeze(['0.164.0-alpha.11.1', '0.166.0-alpha.5.1']);
export const verifiedCodexVersion = value => VERIFIED_CODEX_CLI_VERSIONS.includes(value);
export function parseVerifiedCodexVersion(output) {
  const value = /^codex-cli\s+(\S+)\s*$/m.exec(String(output))?.[1];
  return verifiedCodexVersion(value) ? value : null;
}

// Schema review is separate from a real isolation acceptance. This list never
// grants execution: readCodexLiveProof still binds the binary and every source.
export const REVIEWED_CODEX_PROTOCOL_VERSIONS = Object.freeze([...VERIFIED_CODEX_CLI_VERSIONS, '0.166.0-alpha.6']);
export function parseReviewedCodexVersion(output) {
  const value = /^codex-cli\s+(\S+)\s*$/m.exec(String(output))?.[1];
  return REVIEWED_CODEX_PROTOCOL_VERSIONS.includes(value) ? value : null;
}

// Account transport has a smaller capability surface than work execution.
// Exact 0.167 builds were reviewed against their generated account schemas and
// initialize/config-read/account-read in a fresh isolated home. This list never
// grants model execution, and does not change either work protocol allowlist.
export const ACCOUNT_PROTOCOL_CLI_VERSIONS=Object.freeze([...REVIEWED_CODEX_PROTOCOL_VERSIONS,'0.167.0-alpha.3.2','0.167.0']);
export function parseAccountProtocolVersion(output){
  const value=/^codex-cli\s+(\S+)\s*$/m.exec(String(output))?.[1];
  return ACCOUNT_PROTOCOL_CLI_VERSIONS.includes(value)?value:null;
}
export const DESKTOP_READ_ONLY_VERSIONS = Object.freeze([
  '0.154.0-alpha.6.2','0.155.0-alpha.9','0.155.0-alpha.16','0.155.0-alpha.16.3','0.155.0-alpha.16.4',
  '0.158.0-alpha.2.1','0.160.0','0.160.1','0.162.0-alpha.2','0.162.0-alpha.17.2',
  '0.163.0-alpha.10.2','0.163.0-alpha.11','0.163.0-alpha.11.1','0.163.0-alpha.11.2',
  '0.164.0-alpha.11.1','0.165.0-alpha.1.2','0.166.0-alpha.5.1','0.166.0-alpha.6','0.167.0-alpha.3.2'
]);
