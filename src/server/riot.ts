// src/server/riot.ts
const RIOT_API_KEY = process.env.RIOT_API_KEY!;
const REGION = "europe";

export async function getAccountByRiotId(name: string, tag: string) {
  const endpoint = `https://${REGION}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(
    name
  )}/${encodeURIComponent(tag)}`

  console.log("🔍 URL chiamato:", endpoint)

  const res = await fetch(endpoint, {
    headers: {
      "X-Riot-Token": RIOT_API_KEY,
    },
  })

  if (!res.ok) {
    const errorText = await res.text()
    console.error("❌ Account API failed:", res.status, errorText)
    throw new Error("Account not found")
  }

  return res.json()
}


export async function getMatchIdsByPuuid(puuid: string, count = 5) {
  const res = await fetch(
    `https://${REGION}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?count=${count}`,
    {
      headers: { "X-Riot-Token": RIOT_API_KEY },
    }
  );

  if (!res.ok) {
    throw new Error("Unable to fetch matches");
  }

  return res.json();
}

export async function getRankedDataBySummonerId(summonerId: string) {
  const RIOT_API_KEY = process.env.RIOT_API_KEY

  if (!RIOT_API_KEY) {
    throw new Error("RIOT_API_KEY non definita nel .env")
  }

  const url = `https://euw1.api.riotgames.com/lol/league/v4/entries/by-puuid/${summonerId}`
  console.log("📡 Chiamata API Ranked:", url)

  const response = await fetch(url, {
    headers: {
      "X-Riot-Token": RIOT_API_KEY,
    },
  })

  if (!response.ok) {
    const text = await response.text()
    console.error("❌ Errore Riot API:", response.status, text)
    throw new Error("Errore nella richiesta alle Riot API")
  }

  return await response.json()
}


export async function getMatchDetails(matchId: string) {
  const res = await fetch(
    `https://${REGION}.api.riotgames.com/lol/match/v5/matches/${matchId}`,
    {
      headers: { "X-Riot-Token": RIOT_API_KEY },
    }
  )

  if (!res.ok) {
    const text = await res.text()
    console.error("❌ Errore match API:", res.status, text)
    throw new Error("Errore nel recupero dettagli match")
  }

  return await res.json()
}

export async function getMatchesWithWin(puuid: string, count = 5) {
  const matchIds: string[] = await getMatchIdsByPuuid(puuid, count)

  const matches = await Promise.all(
    matchIds.map(async (id) => {
      const match = await getMatchDetails(id)
      const participant = match.info.participants.find((p: any) => p.puuid === puuid)
      return {
        match,
        win: participant?.win ?? false,
      }
    })
  )

  return matches
}

export async function getLiveGameByPuuid(puuid: string) {
  const RIOT_API_KEY = process.env.RIOT_API_KEY
  if (!RIOT_API_KEY) throw new Error("Missing Riot API key")

  const liveRes = await fetch(
    `https://euw1.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${puuid}`,
    {
      headers: { "X-Riot-Token": RIOT_API_KEY },
    }
  )

  if (!liveRes.ok) {
    const text = await liveRes.text()
    console.error("❌ Spectator API failed:", liveRes.status, text)
    return null
  }

  const liveData = await liveRes.json()
  return liveData
}


