// src/server/routes/assignRoles.ts
import { getRolesMap } from "../supabase/queries"

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

export async function assignRoles(participants: Participant[]) {
    const rolesMap = await getRolesMap()

    const teams: Record<TeamId, Partial<Record<Role, Participant>>> = {
        100: {},
        200: {},
    }

    for (const teamId of [100, 200] as TeamId[]) {
        const team = participants.filter(p => p.teamId === teamId)
        const used = new Set<Participant>()

        const roleOrder: Role[] = ["jungle", "support", "bot", "top", "mid"]

        for (const role of roleOrder) {
            const candidates = team
                .filter(p => !used.has(p))
                .filter(p => {
                    const champRoles = rolesMap[p.championId]
                    if (!champRoles) return false
                    if (role === "jungle") {
                        return champRoles.includes("jungle") && (p.spell1Id === 11 || p.spell2Id === 11)
                    }
                    return champRoles.includes(role)
                })
                .sort((a, b) => {
                    const aRoles = rolesMap[a.championId] || []
                    const bRoles = rolesMap[b.championId] || []

                    const aIndex = aRoles.includes(role) ? aRoles.indexOf(role) : 99
                    const bIndex = bRoles.includes(role) ? bRoles.indexOf(role) : 99

                    return aIndex - bIndex
                })

            const best = candidates[0]
            if (best) {
                teams[teamId][role] = best
                used.add(best)
            }
        }

        // Fallback per ruoli mancanti
        for (const role of roleOrder) {
            if (!teams[teamId][role]) {
                const fallback = team.find(p => !used.has(p))
                if (fallback) {
                    teams[teamId][role] = fallback
                    used.add(fallback)
                }
            }
        }
    }

    return teams
}
