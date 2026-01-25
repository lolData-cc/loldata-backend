// routes/getMasteryList.ts

const regionRouting: Record<string, { account: string; platform: string }> = {
  EUW: { account: "europe.api.riotgames.com", platform: "euw1.api.riotgames.com" },
  NA:  { account: "americas.api.riotgames.com", platform: "na1.api.riotgames.com" },
  KR:  { account: "asia.api.riotgames.com", platform: "kr.api.riotgames.com" },
};

export async function getMasteryListHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { name, tag, region } = body;

    if (!name || !tag || !region) {
      return new Response("Missing name, tag or region", { status: 400 });
    }

    const routing = regionRouting[String(region).toUpperCase()];
    if (!routing) return new Response("Invalid region", { status: 400 });

    const RIOT_API_KEY = process.env.RIOT_API_KEY;
    if (!RIOT_API_KEY) throw new Error("Missing Riot API key");

    const nameLower = String(name).toLowerCase();
    const tagLower = String(tag).toLowerCase();

    // 1) Account -> PUUID
    const accountRes = await fetch(
      `https://${routing.account}/riot/account/v1/accounts/by-riot-id/${nameLower}/${tagLower}`,
      { headers: { "X-Riot-Token": RIOT_API_KEY } }
    );

    if (!accountRes.ok) {
      const err = await accountRes.text();
      console.error("❌ Errore account:", err);
      return new Response("Errore nella richiesta account", { status: 500 });
    }

    const account = await accountRes.json(); // { puuid, gameName, tagLine, ... }

    // 2) Mastery list (ALL champs)
    const masteryRes = await fetch(
      `https://${routing.platform}/lol/champion-mastery/v4/champion-masteries/by-puuid/${account.puuid}`,
      { headers: { "X-Riot-Token": RIOT_API_KEY } }
    );

    if (!masteryRes.ok) {
      const err = await masteryRes.text();
      console.error("❌ Errore mastery:", err);
      return new Response("Errore nella richiesta mastery", { status: 500 });
    }

    const masteryList = await masteryRes.json();

    return Response.json({
      puuid: account.puuid,
      name: account.gameName,
      tag: account.tagLine,
      region: String(region).toUpperCase(),
      masteryList,
    });
  } catch (err) {
    console.error("Errore in getMasteryListHandler:", err);
    return new Response("Errore interno", { status: 500 });
  }
}
