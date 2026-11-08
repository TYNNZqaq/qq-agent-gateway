import { boundedText, integer } from './contracts.mjs';

// W04: only this pure formatter was extracted from the reviewed source.
// Provenance and the deliberately excluded desktop closure are in REUSE.md.
export const referenceLabel = reference => `${reference.project_name} ${reference.kind}${reference.local_number}`;

export function taskReference({projectName,number}) {
  boundedText(projectName,80);integer(number);
  return referenceLabel({project_name:projectName,kind:'T',local_number:number});
}
export function parseTaskReference(input) {
  boundedText(input,128);
  const match=/^(.*?)\s+T\s*([1-9]\d{0,11})$/i.exec(input.trim());
  if(!match||!match[1].trim())return null;
  return Object.freeze({projectName:match[1].trim(),number:Number(match[2])});
}
