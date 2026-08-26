/**
 * Permanent account deletion.
 *
 * Apple requires any app that lets you create an account to let you delete it
 * from inside the app, and health data raises the bar on getting it right.
 *
 * Deleting the auth user is an admin operation, so it cannot happen from the
 * device. This function authenticates the caller with their own JWT, then uses
 * the service-role key to delete exactly that user and nobody else.
 *
 * Everything else follows automatically: profiles, entries and insights all
 * declare `references auth.users(id) on delete cascade` in 0001_init.sql, so
 * the row deletions are the database's job, not this function's. That is worth
 * preserving, because a hand-rolled delete list silently rots the day a table
 * is added.
 */
import { createClient } from "npm:@supabase/supabase-js@2";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Not signed in" }, 401);

  // Step one uses the CALLER's token, never the service role. This is what
  // establishes which account is being deleted: the answer comes from a
  // verified JWT, never from the request body, so no caller can name someone
  // else's id.
  const asUser = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const {
    data: { user },
  } = await asUser.auth.getUser();
  if (!user) return json({ error: "Not signed in" }, 401);

  // Step two escalates, but only to act on the id proven above.
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) return json({ error: error.message }, 500);

  return json({ ok: true });
});
