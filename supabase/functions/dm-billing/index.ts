// =====================================================================
// dm-billing — Dismissal Magic checkout + "manage billing" links
//
// Called from the app by a SIGNED-IN school owner:
//   { action: "checkout", code }  → Stripe Checkout page to subscribe that school
//   { action: "portal",   code }  → Stripe customer portal (card, receipts, cancel)
// Only the account that owns the school can do either.
//
// Founding price ($149/yr) for the first FOUNDING_LIMIT schools to subscribe,
// then the regular price ($249/yr). Schools keep the price they started with.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   STRIPE_SECRET_KEY   sk_live_… (or sk_test_… while testing)
// Optional secrets (defaults below):
//   STRIPE_PRICE_FOUNDING, STRIPE_PRICE_REGULAR, FOUNDING_LIMIT, APP_URL
// SUPABASE_URL and the Supabase server key are provided automatically.
// "Verify JWT" can be OFF: this function checks who's signed in itself (needed with Supabase's newer keys).
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Supabase's server key: newer projects provide SUPABASE_SECRET_KEYS (JSON), older ones SUPABASE_SERVICE_ROLE_KEY.
function serverKey(): string {
  const many = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (many) { try { const v = Object.values(JSON.parse(many)); if (v.length) return String(v[0]); } catch (_) { /* ignore */ } }
  return Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

const PRICE_FOUNDING = Deno.env.get("STRIPE_PRICE_FOUNDING") || "price_1UbNdmPhls0y9gMoJDTiwBGY"; // $149/yr
const PRICE_REGULAR = Deno.env.get("STRIPE_PRICE_REGULAR") || "price_1UbNeSPhls0y9gMoYwCVekyS";   // $249/yr
const FOUNDING_LIMIT = Number(Deno.env.get("FOUNDING_LIMIT") || 25);
const APP_URL = (Deno.env.get("APP_URL") || "https://app.dismissalmagic.com").replace(/\/$/, "");
const APP_TAG = "dismissal-magic"; // marks our Stripe objects so the webhook ignores other STEMstarters sales

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Tiny Stripe REST helper (form-encoded, nested keys like line_items[0][price]).
async function stripe(path: string, params: Record<string, string> = {}, method = "POST") {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${Deno.env.get("STRIPE_SECRET_KEY")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: method === "GET" ? undefined : new URLSearchParams(params),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe ${path}: ${data?.error?.message || res.status}`);
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ ok: false, error: "method" }, 405);

  if (!Deno.env.get("STRIPE_SECRET_KEY")) { console.error("Missing STRIPE_SECRET_KEY secret"); return reply({ ok: false, error: "billing_failed" }); }
  if (!serverKey()) { console.error("No Supabase server key found"); return reply({ ok: false, error: "billing_failed" }); }
  const db = createClient(Deno.env.get("SUPABASE_URL")!, serverKey(), {
    auth: { persistSession: false },
  });

  // Who is asking?
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await db.auth.getUser(jwt);
  const user = auth?.user;
  if (!user) return reply({ ok: false, error: "signed_out" });

  let body: { action?: string; code?: string } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const code = String(body.code || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return reply({ ok: false, error: "not_found" });

  // Only the school's owner.
  const { data: owner } = await db.from("bus_school_owners").select("user_id").eq("code", code).maybeSingle();
  if (!owner || owner.user_id !== user.id) return reply({ ok: false, error: "not_owner" });

  const { data: bill } = await db.from("bus_school_billing").select("*").eq("code", code).maybeSingle();

  try {
    if (body.action === "portal") {
      if (!bill?.stripe_customer_id) return reply({ ok: false, error: "no_billing" });
      const s = await stripe("billing_portal/sessions", {
        customer: bill.stripe_customer_id,
        return_url: `${APP_URL}/account`,
      });
      return reply({ ok: true, url: s.url });
    }

    if (body.action === "checkout") {
      if (bill?.comped) return reply({ ok: false, error: "already_free" });
      const live = ["active", "trialing", "past_due"];
      if (bill?.status && live.includes(bill.status) && bill.paid_until && new Date(bill.paid_until) > new Date()) {
        return reply({ ok: false, error: "already_subscribed" });
      }

      // Founding price while spots remain.
      const { count } = await db
        .from("bus_school_billing")
        .select("code", { count: "exact", head: true })
        .eq("plan", "founding")
        .in("status", live);
      const founding = (count ?? 0) < FOUNDING_LIMIT;
      const price = founding ? PRICE_FOUNDING : PRICE_REGULAR;

      // School name for the receipt.
      const { data: school } = await db.rpc("bus_get_school", { p_code: code });
      const name = (school?.settings?.name || code).slice(0, 80);

      const params: Record<string, string> = {
        mode: "subscription",
        "line_items[0][price]": price,
        "line_items[0][quantity]": "1",
        success_url: `${APP_URL}/account?paid=${code}`,
        cancel_url: `${APP_URL}/account`,
        allow_promotion_codes: "true",
        billing_address_collection: "auto",
        client_reference_id: code,
        "metadata[app]": APP_TAG,
        "metadata[code]": code,
        "subscription_data[metadata][app]": APP_TAG,
        "subscription_data[metadata][code]": code,
        "subscription_data[metadata][school]": name,
        "subscription_data[description]": `Dismissal Magic — ${name} (${code})`,
        "custom_text[submit][message]": `Subscription for ${name}. Renews yearly; cancel anytime from My schools → Manage billing.`,
      };
      if (bill?.stripe_customer_id) params.customer = bill.stripe_customer_id;
      else params.customer_email = user.email || "";

      const s = await stripe("checkout/sessions", params);
      return reply({ ok: true, url: s.url, plan: founding ? "founding" : "regular" });
    }

    return reply({ ok: false, error: "action" }, 400);
  } catch (e) {
    console.error(e);
    return reply({ ok: false, error: "billing_failed" });
  }
});
