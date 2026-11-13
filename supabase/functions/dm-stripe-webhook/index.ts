// =====================================================================
// dm-stripe-webhook — keeps each school's "paid until" date in sync with Stripe
//
// Stripe calls this when a Dismissal Magic subscription starts, renews,
// changes or ends. We re-read the subscription from Stripe and save it to
// bus_school_billing, which is what the School Dashboard's lock checks.
// Other STEMstarters sales in the same Stripe account are ignored.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   STRIPE_SECRET_KEY       sk_live_… (same as the billing function)
//   DM_STRIPE_WEBHOOK_SECRET  whsec_…  from Stripe → Developers → Webhooks → the Dismissal Magic endpoint
//   (named DM_… so it doesn't overwrite 3D Print Quest's STRIPE_WEBHOOK_SECRET)
// Optional: STRIPE_PRICE_FOUNDING (default below)
// Turn "Verify JWT" OFF for this function (Stripe signs its own requests).
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Supabase's server key: newer projects provide SUPABASE_SECRET_KEYS (JSON), older ones SUPABASE_SERVICE_ROLE_KEY.
function serverKey(): string {
  const many = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (many) { try { const v = Object.values(JSON.parse(many)); if (v.length) return String(v[0]); } catch (_) { /* ignore */ } }
  return Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

const PRICE_FOUNDING = Deno.env.get("STRIPE_PRICE_FOUNDING") || "price_1UbNdmPhls0y9gMoJDTiwBGY";
const APP_TAG = "dismissal-magic";
const GRACE_DAYS = 7; // a late card payment doesn't shut a school off on day one

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

// Stripe signature check: header "t=…,v1=…"; HMAC-SHA256 of "t.payload" with the endpoint secret.
async function verify(payload: string, header: string, secret: string) {
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
  const t = parts.t;
  const sigs = header.split(",").filter((kv) => kv.startsWith("v1=")).map((kv) => kv.slice(3));
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // 5-minute window
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`)));
  return sigs.some((s) => s.length === expected.length && [...s].every((c, i) => c === expected[i]));
}

async function getSubscription(id: string) {
  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${id}`, {
    headers: { Authorization: `Bearer ${Deno.env.get("STRIPE_SECRET_KEY")}` },
  });
  if (!res.ok) throw new Error(`Stripe subscription ${id}: ${res.status} ${await res.text()}`);
  return await res.json();
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  const payload = await req.text();
  const ok = await verify(payload, req.headers.get("stripe-signature") || "", Deno.env.get("DM_STRIPE_WEBHOOK_SECRET") || "");
  if (!ok) return new Response("bad signature", { status: 400 });

  const event = JSON.parse(payload);
  const obj = event.data?.object || {};

  // Find the subscription this event is about.
  let subId: string | null = null;
  if (obj.object === "subscription") subId = obj.id;
  else if (obj.object === "checkout.session") subId = obj.subscription;
  else if (obj.object === "invoice") subId = obj.subscription || obj.parent?.subscription_details?.subscription || null;
  if (!subId) return new Response(JSON.stringify({ ignored: event.type }), { status: 200 });

  try {
    const sub = await getSubscription(subId);
    if (sub.metadata?.app !== APP_TAG || !sub.metadata?.code) {
      return new Response(JSON.stringify({ ignored: "not dismissal magic" }), { status: 200 });
    }
    const code = String(sub.metadata.code).toUpperCase();
    const item = sub.items?.data?.[0];
    const periodEnd: number | undefined = sub.current_period_end ?? item?.current_period_end; // newer API versions keep it on the item
    const priceId: string | undefined = item?.price?.id;

    let paidUntil: string | null = null;
    if (["active", "trialing"].includes(sub.status) && periodEnd) {
      paidUntil = new Date(periodEnd * 1000).toISOString();
    } else if (sub.status === "past_due" && periodEnd) {
      paidUntil = new Date((periodEnd + GRACE_DAYS * 86400) * 1000).toISOString();
    } else if (sub.status === "canceled" || sub.status === "unpaid" || sub.status === "incomplete_expired") {
      paidUntil = new Date().toISOString(); // ended
    } // "incomplete": leave as is until payment finishes

    const db = createClient(Deno.env.get("SUPABASE_URL")!, serverKey(), {
      auth: { persistSession: false },
    });
    const row: Record<string, unknown> = {
      code,
      plan: priceId === PRICE_FOUNDING ? "founding" : "regular",
      stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer?.id,
      stripe_subscription_id: sub.id,
      status: sub.status,
      updated_at: new Date().toISOString(),
    };
    if (paidUntil !== null) row.paid_until = paidUntil;
    const { error } = await db.from("bus_school_billing").upsert(row, { onConflict: "code" });
    if (error) throw error;

    return new Response(JSON.stringify({ ok: true, code, status: sub.status }), { status: 200 });
  } catch (e) {
    console.error(e);
    return new Response("error", { status: 500 }); // Stripe retries
  }
});
