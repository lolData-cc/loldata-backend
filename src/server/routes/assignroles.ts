// src/server/routes/assignRoles.ts
// Smart role assignment using: smite detection, champion role map,
// and player's actual role history from the DB (participants table).

import { getRolesMap } from "../supabase/queries"
import { supabaseAdmin, supabaseMatchAdmin } from "../supabase/client" // match → box, users → box (migrated 2026-08-28)

export type TeamId = 100 | 200
export type Role = "top" | "jungle" | "mid" | "bot" | "support"

export type Participant = {
    teamId: number
    summonerName: string
    championId: number
    riotId: string
    spell1Id: number
    spell2Id: number
}

const ALL_ROLES: Role[] = ["top", "jungle", "mid", "bot", "support"]

function normalizeRole(role: string): Role | null {
  const r = (role ?? "").toUpperCase().trim()
  if (r === "TOP") return "top"
  if (r === "JUNGLE") return "jungle"
  if (r === "MIDDLE" || r === "MID") return "mid"
  if (r === "BOTTOM" || r === "BOT" || r === "ADC") return "bot"
  if (r === "UTILITY" || r === "SUPPORT" || r === "SUP") return "support"
  return null
}

/** Fetch each player's role distribution from their recent games in the DB */
async function getPlayerRoleHistories(
  riotIds: string[]
): Promise<Map<string, Map<Role, number>>> {
  // Resolve riotIds -> puuids
  const names = riotIds.map(id => {
    const [name, tag] = id.split("#")
    return { name, tag, riotId: id }
  }).filter(x => x.name && x.tag)

  if (names.length === 0) return new Map()

  const { data: users } = await supabaseMatchAdmin
    .from("users")
    .select("puuid, name, tag")
    .in("name", names.map(n => n.name))

  const riotIdToPuuid = new Map<string, string>()
  for (const n of names) {
    const user = (users ?? []).find(
      u => u.name?.toLowerCase() === n.name!.toLowerCase() &&
           u.tag?.toLowerCase() === n.tag!.toLowerCase()
    )
    if (user?.puuid) riotIdToPuuid.set(n.riotId, user.puuid)
  }

  const puuids = [...riotIdToPuuid.values()]
  if (puuids.length === 0) return new Map()

  // Fetch role counts from participants table
  const { data: rows } = await supabaseMatchAdmin
    .from("participants")
    .select("puuid, role")
    .in("puuid", puuids)
    .not("role", "is", null)
    .not("role", "eq", "")

  // Build puuid -> role counts
  const puuidRoles = new Map<string, Map<Role, number>>()
  for (const row of rows ?? []) {
    const role = normalizeRole(row.role)
    if (!role) continue
    if (!puuidRoles.has(row.puuid)) puuidRoles.set(row.puuid, new Map())
    const m = puuidRoles.get(row.puuid)!
    m.set(role, (m.get(role) ?? 0) + 1)
  }

  // Map back to riotId
  const result = new Map<string, Map<Role, number>>()
  for (const [riotId, puuid] of riotIdToPuuid) {
    const roles = puuidRoles.get(puuid)
    if (roles) result.set(riotId, roles)
  }

  return result
}

/**
 * Score how well a player-role assignment fits.
 * Higher = better fit.
 */
function scoreAssignment(
  p: Participant,
  role: Role,
  champRoles: Role[] | undefined,
  playerHistory: Map<Role, number> | undefined,
): number {
  let score = 0

  // 1. Smite = jungle (very strong signal)
  const hasSmite = p.spell1Id === 11 || p.spell2Id === 11
  if (role === "jungle" && hasSmite) score += 1000
  if (role === "jungle" && !hasSmite) score -= 500
  if (role !== "jungle" && hasSmite) score -= 500

  // 2. Champion can play this role (from champion DB)
  if (champRoles) {
    const idx = champRoles.indexOf(role)
    if (idx === 0) score += 100       // primary role
    else if (idx > 0) score += 50     // secondary role
    else score -= 30                  // champ doesn't play this role
  }

  // 3. Player's actual history (strongest signal after smite)
  if (playerHistory && playerHistory.size > 0) {
    const totalGames = [...playerHistory.values()].reduce((a, b) => a + b, 0)
    const gamesInRole = playerHistory.get(role) ?? 0
    const pct = totalGames > 0 ? gamesInRole / totalGames : 0

    // Main role (>40% of games) = big bonus
    if (pct > 0.4) score += 200
    else if (pct > 0.2) score += 100
    else if (pct > 0.05) score += 30
    // Never played this role = penalty
    if (gamesInRole === 0 && totalGames > 10) score -= 50
  }

  return score
}

/**
 * Find the optimal role assignment using brute-force permutation
 * (only 5 players per team, so 5! = 120 permutations — trivial).
 */
function findBestAssignment(
  team: Participant[],
  champRolesMap: Record<number, Role[]>,
  playerHistories: Map<string, Map<Role, number>>,
): Record<Role, Participant> {
  const roles = ALL_ROLES.slice(0, team.length) // handle <5 player edge case
  let bestScore = -Infinity
  let bestAssignment: Record<Role, Participant> = {} as any

  function permute(remaining: Participant[], assignedRoles: Role[], current: [Role, Participant][]) {
    if (assignedRoles.length === roles.length || remaining.length === 0) {
      // Score this full assignment
      let totalScore = 0
      for (const [role, p] of current) {
        totalScore += scoreAssignment(
          p,
          role,
          champRolesMap[p.championId],
          playerHistories.get(p.riotId),
        )
      }
      if (totalScore > bestScore) {
        bestScore = totalScore
        bestAssignment = {} as any
        for (const [role, p] of current) {
          bestAssignment[role] = p
        }
      }
      return
    }

    const nextRole = roles[assignedRoles.length]!
    for (let i = 0; i < remaining.length; i++) {
      const player = remaining[i]!
      const newRemaining = [...remaining.slice(0, i), ...remaining.slice(i + 1)]
      permute(newRemaining, [...assignedRoles, nextRole], [...current, [nextRole, player]])
    }
  }

  permute(team, [], [])
  return bestAssignment
}

export async function assignRoles(participants: Participant[]) {
  // Fetch champion role map and player histories in parallel
  const riotIds = participants.map(p => p.riotId).filter(Boolean)
  const [champRolesMap, playerHistories] = await Promise.all([
    getRolesMap(),
    getPlayerRoleHistories(riotIds),
  ])

  const teams: Record<TeamId, Partial<Record<Role, Participant>>> = {
    100: {},
    200: {},
  }

  for (const teamId of [100, 200] as TeamId[]) {
    const team = participants.filter(p => p.teamId === teamId)
    if (team.length === 0) continue

    const best = findBestAssignment(team, champRolesMap, playerHistories)
    teams[teamId] = best
  }

  return teams
}
