/**
 * Visual top-to-bottom fill ordering (scroll Y, then X; type as tie-breaker).
 * Apply-aware order (required + logical band) lives in fieldMapper.js.
 */

export const FIELD_TYPE_ORDER = {
  fullname: 10,
  firstname: 11,
  lastname: 12,
  email: 20,
  tel: 25,
  address1: 30,
  address2: 31,
  city: 32,
  state: 33,
  zip: 34,
  country: 35,
  location: 36,
  desiredtitle: 40,
  linkedinurl: 45,
  website: 46,
  pronouns: 15,
  salary: 55,
  visasponsorship: 60,
  workauthorization: 59,
  remotepreference: 58,
  willingtorelocate: 57,
  hidecompanies: 56,
  policyack: 60,
  eeocgender: 61,
  eeocrace: 62,
  eeocveteran: 63,
  eeocdisability: 64,
  citystatezip: 34,
  resume: 70,
  coverletter: 80,
  additionalinfo: 90,
};

export function compareVisualOrder(a, b) {
  const ay = Number(a?.top ?? a?.y ?? 1e9);
  const by = Number(b?.top ?? b?.y ?? 1e9);
  if (ay !== by) return ay - by;
  const ax = Number(a?.left ?? a?.x ?? 0);
  const bx = Number(b?.left ?? b?.x ?? 0);
  if (ax !== bx) return ax - bx;
  const ao = FIELD_TYPE_ORDER[a?.type] ?? FIELD_TYPE_ORDER[a?.mappedTo] ?? 50;
  const bo = FIELD_TYPE_ORDER[b?.type] ?? FIELD_TYPE_ORDER[b?.mappedTo] ?? 50;
  return ao - bo;
}

export function sortByVisualOrder(entries) {
  return [...(entries || [])].sort(compareVisualOrder);
}

export {
  sortApplyFields,
  sortFieldsIntelligently,
  compareApplyFillOrder,
  isJobApplicationField,
  isNoiseApplicationField,
  detectRequiredUnfilled,
  buildRequiredFieldsInstruction,
  looksRequiredField,
  isTrulyRequired,
  isVoluntaryField,
  isEarlyCustomControl,
  requiredPriorityRank,
} from "./fieldMapper.js";
