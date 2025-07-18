import { getChampionData } from "../../supabase/queries"
import OpenAI from "openai"

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export async function howToWinHandler(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { enemyChampionIds } = body;

    if (!enemyChampionIds?.length) {
      return new Response("Missing enemyChampionIds", { status: 400 });
    }

    const champions = await Promise.all(
      enemyChampionIds.map((id: number) => getChampionData(id))
    );

    const summary = champions.map(c =>
      `${c.name} (${c.type}, ${c.range_type}, roles: [${c.roles.join(", ")}], tags: [${(c.tags || []).join(", ")}])`
    ).join("\n");

    const prompt = `
You're a high-ELO League of Legends coach.

Enemy team:
${summary}

How can I win this game? please dont talk about matchups and what to build because those are other requests. Please give an answer highly related to the game champions and compositions. Use a maximum of 750 characters and be very concise
Give:
- Strengths and weaknesses
- Teamfight advice
- Macro/objective tips
    `;

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "You are a League of Legends expert coach." },
        { role: "user", content: prompt },
      ],
    });

    const advice = completion.choices[0].message.content;
    return Response.json({ advice });
  } catch (err) {
    console.error("❌ Errore howToWinHandler:", err);
    return new Response("Internal Server Error", { status: 500 });
  }
}
