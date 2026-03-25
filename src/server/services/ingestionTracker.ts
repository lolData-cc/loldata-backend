// Simple in-memory tracker for active ingestion processes.
// Shared between getSummoner (which starts ingestion) and getMatches (which checks status).

const activeIngestions = new Set<string>(); // puuid set

export function markIngesting(puuid: string) {
  activeIngestions.add(puuid);
}

export function markDone(puuid: string) {
  activeIngestions.delete(puuid);
}

export function isIngesting(puuid: string): boolean {
  return activeIngestions.has(puuid);
}
