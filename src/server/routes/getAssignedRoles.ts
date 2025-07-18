// src/server/routes/getAssignedRoles.ts
import { assignRoles } from "./assignroles"

export async function getAssignedRolesHandler(req: Request): Promise<Response> {
  try {
    const { participants } = await req.json()

    if (!participants || !Array.isArray(participants)) {
      return new Response("Invalid participants", { status: 400 })
    }

    const roles = await assignRoles(participants)
    return Response.json({ roles })
  } catch (err) {
    console.error("❌ Errore in getAssignedRolesHandler:", err)
    return new Response("Errore interno", { status: 500 })
  }
}
