// src/server/supabase/queries.ts
import type { Role } from "../routes/assignroles"
import { supabase } from "./client"

type Participant = {
  teamId: number
  summonerName: string
  championId: number
  spell1Id: number
  spell2Id: number
  perks: any
}

export async function saveLiveGame(puuid: string, participants: Participant[]) {
  const { error } = await supabase
    .from("live_games")
    .insert([{ puuid, participants, created_at: new Date().toISOString() }])

  if (error) {
    console.error("Errore nel salvataggio live game:", error)
    throw new Error(error.message)
  }
}


export async function getChampionData(championId: number) {
  console.log("🔎 Cerco champion ID:", championId, typeof championId)

  const { data, error } = await supabase
    .from("champions")
    .select("*")
    .filter("id", "eq", championId.toString()) // compat stringa
    .maybeSingle()

  if (!data) {
    console.warn("⚠️  Nessun dato ricevuto da Supabase per:", championId)
    console.log("⬅️ Response da Supabase:", { data, error })
  }

  if (error) {
    console.error("❌ Errore nel recupero champion:", error)
    throw new Error(error.message)
  }

  if (!data) {
    throw new Error(`Champion ID ${championId} non trovato`)
  }

  return data
}

export async function getRolesMap(): Promise<Record<number, Role[]>> {
  const { data, error } = await supabase
    .from("champions")
    .select("id, roles")

  if (error) {
    console.error("❌ Errore Supabase:", error)
    throw new Error("Impossibile caricare i ruoli dei champion")
  }

  const map: Record<number, Role[]> = {}
  for (const champ of data || []) {
    map[champ.id] = champ.roles
  }

  return map
}

export async function getMatchupTips(champ1Id: number, champ2Id: number): Promise<string | null> {
  const { data, error } = await supabase
    .from("matchups")
    .select("tips")
    .or(`champ1id.eq.${champ1Id},champ2id.eq.${champ2Id}`)
    .or(`champ1id.eq.${champ2Id},champ2id.eq.${champ1Id}`)
    .limit(1)
    .single();

  if (error) {
    console.error("❌ Supabase matchup error:", error);
    return null;
  }

  return data?.tips || null;
}