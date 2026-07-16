// Device-link sign-in: exchanges a short-lived code (created by a signed-in
// PC) for a one-time magic-link token the device can verify to establish its
// own session — no browser OAuth needed on the device.
//
// POST { code: "ABC123" }  (anon key — the device is not signed in yet)
//   → { token_hash, email }  on success; the device calls
//     supabase.auth.verifyOtp({ type: "magiclink", token_hash }).

import { createClient } from "jsr:@supabase/supabase-js@2";

const CODE_TTL_MS = 10 * 60 * 1000;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  try {
    const { code } = await req.json();
    const normalized = String(code ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(normalized)) {
      return json({ error: "invalid_code" }, 400);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: row } = await admin
      .from("device_link_codes")
      .select("code, user_id, created_at")
      .eq("code", normalized)
      .maybeSingle();

    // One-shot: delete regardless of outcome below
    if (row) {
      await admin.from("device_link_codes").delete().eq("code", normalized);
    }

    if (!row || Date.now() - new Date(row.created_at).getTime() > CODE_TTL_MS) {
      return json({ error: "code_not_found_or_expired" }, 404);
    }

    const { data: userData, error: userErr } = await admin.auth.admin
      .getUserById(row.user_id);
    if (userErr || !userData?.user?.email) {
      return json({ error: "user_not_found" }, 404);
    }

    const { data: linkData, error: linkErr } = await admin.auth.admin
      .generateLink({
        type: "magiclink",
        email: userData.user.email,
      });
    if (linkErr || !linkData?.properties?.hashed_token) {
      return json({ error: "link_generation_failed" }, 500);
    }

    return json({
      token_hash: linkData.properties.hashed_token,
      email: userData.user.email,
    });
  } catch (_err) {
    return json({ error: "bad_request" }, 400);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
