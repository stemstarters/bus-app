// =====================================================================
// send-email — Supabase "Send Email" hook
//
// Supabase calls this instead of its own mailer for every sign-in,
// signup, password-reset, invite and email-change message. We look at
// where the link goes back to and send from the right app:
//
//   Dismissal Magic  (app.dismissalmagic.com) → noreply@mail.dismissalmagic.com
//   3D Print Quest   (app.stemstarters.com)   → noreply@mail.stemstarters.com
//
// Secrets (Supabase → Edge Functions → Secrets):
//   RESEND_API_KEY          re_…  from Resend → API Keys
//   SEND_EMAIL_HOOK_SECRET  v1,whsec_…  from Supabase → Authentication → Hooks
// SUPABASE_URL is provided automatically.
// =====================================================================
import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0";

type Brand = {
  key: string;
  name: string;
  from: string;
  site: string;
  color: string;
  accent: string;
  bg: string;
  emoji: string;
  tagline: string;
};

const BRANDS: Record<string, Brand> = {
  dismissal: {
    key: "dismissal",
    name: "Dismissal Magic",
    from: "Dismissal Magic <noreply@mail.dismissalmagic.com>",
    site: "app.dismissalmagic.com",
    color: "#9246DD",
    accent: "#F8C631",
    bg: "#fdf6e3",
    emoji: "🚌",
    tagline: "Quiet bus calls, like magic.",
  },
  quest: {
    key: "quest",
    name: "3D Print Quest",
    from: "3D Print Quest <noreply@mail.stemstarters.com>",
    site: "app.stemstarters.com",
    color: "#2FC2A3",
    accent: "#FC52B3",
    bg: "#f3fbf9",
    emoji: "🧩",
    tagline: "A STEMstarters app.",
  },
};

// Which app is this email for? Decided by where the link sends people back to.
function pickBrand(redirectTo: string, siteUrl: string): Brand {
  const where = `${redirectTo || ""} ${siteUrl || ""}`.toLowerCase();
  if (where.includes("dismissalmagic")) return BRANDS.dismissal;
  if (redirectTo && /dismissal|bus-app|bus\.stemstarters/.test(redirectTo.toLowerCase())) return BRANDS.dismissal;
  return BRANDS.quest; // app.stemstarters.com and anything else
}

// Words for each kind of email.
function copyFor(action: string, brand: Brand) {
  switch (action) {
    case "signup":
      return { subject: `Confirm your email for ${brand.name}`, title: "Confirm your email", body: `Tap the button to confirm your email and finish setting up your ${brand.name} account.`, button: "Confirm my email" };
    case "recovery":
      return { subject: `Reset your ${brand.name} password`, title: "Reset your password", body: "Tap the button to choose a new password.", button: "Reset password" };
    case "invite":
      return { subject: `You're invited to ${brand.name}`, title: "You're invited!", body: `Someone invited you to join ${brand.name}. Tap the button to accept.`, button: "Accept invite" };
    case "email_change":
      return { subject: `Confirm your new email for ${brand.name}`, title: "Confirm your email change", body: "Tap the button to confirm this email address for your account.", button: "Confirm email" };
    case "reauthentication":
      return { subject: `Your ${brand.name} confirmation code`, title: "Your confirmation code", body: "Enter this code to continue.", button: "" };
    case "magiclink":
    default:
      return { subject: `Your ${brand.name} sign-in link`, title: `Sign in to ${brand.name}`, body: "Tap the button to sign in. No password needed.", button: "Sign in" };
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function renderEmail(brand: Brand, action: string, link: string, code: string) {
  const c = copyFor(action, brand);
  const button = c.button
    ? `<tr><td align="center" style="padding:8px 0 24px">
         <a href="${esc(link)}" style="display:inline-block;background:${brand.color};color:#ffffff;font:bold 18px Arial,Helvetica,sans-serif;text-decoration:none;padding:16px 36px;border-radius:999px;border-bottom:4px solid #2b2d42">${esc(c.button)}</a>
       </td></tr>
       <tr><td style="font:13px/1.5 Arial,Helvetica,sans-serif;color:#5c5f78;padding:0 0 8px">Button not working? Copy this link into your browser:<br><a href="${esc(link)}" style="color:${brand.color};word-break:break-all">${esc(link)}</a></td></tr>`
    : "";
  const codeRow = code
    ? `<tr><td align="center" style="padding:${c.button ? "8px" : "4px"} 0 20px;font:13px Arial,Helvetica,sans-serif;color:#5c5f78">${c.button ? "Or enter this code:" : ""}<div style="font:bold 30px/1.2 'Courier New',monospace;letter-spacing:6px;color:#2b2d42;padding-top:6px">${esc(code)}</div></td></tr>`
    : "";

  const html = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:${brand.bg}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${brand.bg};padding:28px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:24px;border:3px solid #2b2d42;overflow:hidden">
    <tr><td style="background:${brand.color};padding:22px 28px;font:bold 22px Arial,Helvetica,sans-serif;color:#ffffff">${brand.emoji} ${esc(brand.name)}
      <div style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${brand.accent};margin-left:6px"></div></td></tr>
    <tr><td style="padding:28px 28px 8px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="font:bold 26px/1.25 Arial,Helvetica,sans-serif;color:#2b2d42;padding-bottom:10px">${esc(c.title)}</td></tr>
        <tr><td style="font:16px/1.5 Arial,Helvetica,sans-serif;color:#2b2d42;padding-bottom:20px">${esc(c.body)}</td></tr>
        ${button}
        ${codeRow}
        <tr><td style="font:13px/1.5 Arial,Helvetica,sans-serif;color:#5c5f78;padding:8px 0 24px;border-top:1px solid #eee">This link expires soon and works once. If you didn't ask for this email, you can ignore it.</td></tr>
      </table>
    </td></tr>
  </table>
  <div style="font:12px Arial,Helvetica,sans-serif;color:#5c5f78;padding-top:14px">${esc(brand.tagline)} · ${esc(brand.site)}</div>
</td></tr></table></body></html>`;

  const text = `${c.title}\n\n${c.body}\n\n${c.button ? `${c.button}: ${link}\n\n` : ""}${code ? `Code: ${code}\n\n` : ""}If you didn't ask for this email, you can ignore it.\n\n${brand.name} · ${brand.site}`;
  return { subject: c.subject, html, text };
}

async function send(brand: Brand, to: string, mail: { subject: string; html: string; text: string }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: brand.from, to: [to], subject: mail.subject, html: mail.html, text: mail.text }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

function verifyLink(tokenHash: string, action: string, redirectTo: string) {
  const base = Deno.env.get("SUPABASE_URL");
  const u = new URL(`${base}/auth/v1/verify`);
  u.searchParams.set("token", tokenHash);
  u.searchParams.set("type", action);
  if (redirectTo) u.searchParams.set("redirect_to", redirectTo);
  return u.toString();
}

const fail = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { http_code: status, message } }), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return fail(405, "Method not allowed");

  const payload = await req.text();
  const secret = (Deno.env.get("SEND_EMAIL_HOOK_SECRET") || "").replace("v1,whsec_", "");
  let data: any;
  try {
    data = new Webhook(secret).verify(payload, Object.fromEntries(req.headers));
  } catch (_e) {
    return fail(401, "Invalid signature");
  }

  try {
    const { user, email_data: d } = data;
    const action: string = d.email_action_type;
    const brand = pickBrand(d.redirect_to, d.site_url);

    if (action === "email_change" && user.new_email) {
      // Supabase's naming: token_hash_new goes to the CURRENT address, token_hash to the NEW one.
      if (d.token_hash_new) {
        await send(brand, user.email, renderEmail(brand, action, verifyLink(d.token_hash_new, action, d.redirect_to), ""));
      }
      await send(brand, user.new_email, renderEmail(brand, action, verifyLink(d.token_hash, action, d.redirect_to), ""));
    } else if (action === "reauthentication") {
      await send(brand, user.email, renderEmail(brand, action, "", d.token));
    } else {
      await send(brand, user.email, renderEmail(brand, action, verifyLink(d.token_hash, action, d.redirect_to), ""));
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error(e);
    return fail(500, "Could not send email");
  }
});
