import { getMatchDetails, getMatchIdsByPuuidOpts } from "../riot";
import { getCurrentSeasonWindow } from "../season";
import { supabaseAdmin } from "../supabase/client"; 

const Q_SOLO = 420;
const Q_FLEX = 440;

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function queuesFor(group: "ranked_all" | "ranked_solo" | "ranked_flex") {
  if (group === "ranked_solo") return [Q_SOLO];
  if (group === "ranked_flex") return [Q_FLEX];
  return [Q_SOLO, Q_FLEX];
}

async function tryAdvisoryLock(key: string) {
  // pg_try_advisory_lock(hashtext(key))
  const { data, error } = await supabaseAdmin.rpc("pg_try_advisory_lock_hashtext", { key_text: key });
  if (error) throw error;
  return Boolean(data);
}

async function advisoryUnlock(key: string) {
  await supabaseAdmin.rpc("pg_advisory_unlock_hashtext", { key_text: key }).catch(() => {});
}

/**
 * Serve 2 RPC piccole perché supabase non espone pg_try_advisory_lock direttamente.
 * Le crei una volta (SQL sotto).
 */
