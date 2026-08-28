import { supabaseMatchAdmin } from "../supabase/client";

/**
 * The profile icon for one `name#tag`, and nothing else.
 *
 * It exists because two pages used to read `users.icon_id` straight from
 * Supabase Cloud in the browser. `users` moved to the box on 2026-08-28, and the
 * box's PostgREST is not exposed to the internet — so the only way in is through
 * here.
 *
 * ⚠️ A miss is 200 with `iconId: null`, never a 404. The caller already draws a
 * default icon when it has no id; turning "this player has no icon on record"
 * into an error would make a normal, common case look like a failure.
 */
export async function userIconHandler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const nametag = (url.searchParams.get("nametag") ?? "").trim();
  const [name, tag] = nametag.split("#");
  if (!name || !tag) {
    return Response.json({ error: "nametag richiesto nella forma name#tag" }, { status: 400 });
  }

  const { data, error } = await supabaseMatchAdmin
    .from("users")
    .select("icon_id")
    .eq("name", name)
    .eq("tag", tag)
    .maybeSingle();

  if (error) return Response.json({ iconId: null }, { status: 200 });
  return Response.json({ iconId: data?.icon_id ?? null }, { status: 200 });
}
