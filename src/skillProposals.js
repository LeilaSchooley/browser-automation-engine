/**
 * Human approval queue for medium/low-confidence situation skill proposals.
 */
import fs from "fs";
import path from "path";
import { normalizeHost } from "./host.js";
import { getSettings } from "./runtime.js";
import { recordSiteLearning, mergeSituationSkills } from "./siteLearnings.js";
import { recordEngineEvent } from "./observability.js";

function proposalsPath() {
  return String(getSettings().skill_proposals_path || "").trim();
}

function readStore() {
  const filePath = proposalsPath();
  if (!filePath || !fs.existsSync(filePath)) return { proposals: [] };
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return { proposals: Array.isArray(data.proposals) ? data.proposals : [] };
  } catch {
    return { proposals: [] };
  }
}

function writeStore(store) {
  const filePath = proposalsPath();
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2));
}

/**
 * @param {object} proposal
 */
export function enqueueSkillProposal(proposal) {
  const filePath = proposalsPath();
  if (!filePath || !proposal?.skill) return null;
  const store = readStore();
  const id = proposal.id || `prop_${Date.now().toString(36)}`;
  const entry = {
    id,
    status: "pending",
    createdAt: new Date().toISOString(),
    host: normalizeHost(proposal.host || ""),
    evidence: String(proposal.evidence || "").slice(0, 400),
    skill: proposal.skill,
    ...proposal,
    id,
    status: "pending",
  };
  // Dedupe by signature::action pending
  const key = `${entry.skill.signature}::${entry.skill.action}`;
  const existing = store.proposals.find(
    (p) => p.status === "pending" && `${p.skill?.signature}::${p.skill?.action}` === key,
  );
  if (existing) {
    existing.evidence = entry.evidence;
    existing.updatedAt = entry.createdAt;
    writeStore(store);
    return existing;
  }
  store.proposals.push(entry);
  writeStore(store);
  recordEngineEvent("skill_proposed", {
    id,
    host: entry.host,
    signature: entry.skill.signature,
    action: entry.skill.action,
  });
  return entry;
}

export function listSkillProposals({ status = "pending" } = {}) {
  const store = readStore();
  if (!status) return store.proposals;
  return store.proposals.filter((p) => p.status === status);
}

/**
 * Merge approved proposals into host situationSkills; mark processed.
 */
export function applyApprovedSkillProposals(hostname = "") {
  const store = readStore();
  const host = normalizeHost(hostname);
  let applied = 0;
  for (const p of store.proposals) {
    if (p.status !== "approved") continue;
    if (host && normalizeHost(p.host) !== host) continue;
    if (p.mergedAt) continue;
    recordSiteLearning(p.host || host, {
      situationSkills: mergeSituationSkills([], [{ ...p.skill, successCount: p.skill.successCount || 1 }]),
    });
    p.mergedAt = new Date().toISOString();
    applied += 1;
    recordEngineEvent("skill_harvest", {
      source: "approval",
      host: p.host,
      signature: p.skill?.signature,
      action: p.skill?.action,
    });
  }
  if (applied) writeStore(store);
  return applied;
}

export function setSkillProposalStatus(id, status) {
  const store = readStore();
  const p = store.proposals.find((x) => x.id === id);
  if (!p) return null;
  p.status = status;
  p.updatedAt = new Date().toISOString();
  writeStore(store);
  if (status === "approved") {
    applyApprovedSkillProposals(p.host);
  }
  return p;
}
