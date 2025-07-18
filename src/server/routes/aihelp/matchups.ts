import { getMatchupTips } from "../../supabase/queries"
import OpenAI from "openai"

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! })

export async function matchupsHandler(req: Request): Promise<Response> {
  try {
    const { allyChampionId, enemyChampionId } = await req.json()

    if (!allyChampionId || !enemyChampionId) {
      return new Response("Missing champion IDs", { status: 400 })
    }

    const tip = await getMatchupTips(allyChampionId, enemyChampionId)

    if (!tip) {
      return Response.json({ advice: "No specific matchup data found." })
    }

    const prompt = `
You're a high-elo League of Legends coach.
Interpret and expand this matchup advice: "${tip}"
Make it concise, actionable, and limited to 500 characters.
Say something insightful for a player who plays ${allyChampionId} against ${enemyChampionId}.
`

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "You are a League of Legends expert coach." },
        { role: "user", content: prompt },
      ],
    })

    const advice = completion.choices[0].message.content
    return Response.json({ advice })
  } catch (err) {
    console.error("❌ Errore matchupsHandler:", err)
    return new Response("Internal Server Error", { status: 500 })
  }
}
