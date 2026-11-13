import { CONFIG } from "./config.js";

/* =====================================================================
   Dismissal Magic — one page, three screens:
     /               → home (create a school / enter a code)
     /CODE           → classroom screen
     /CODE/admin     → master panel (PIN)
   ===================================================================== */

const $app = document.getElementById("app");
const $modal = document.getElementById("modal-root");
const DEMO = !CONFIG.supabaseUrl || !CONFIG.supabaseAnonKey;
const GO_NOW_MS = 5 * 60 * 1000; // how long a call shows as "GO NOW"

/* ---------------------------- small helpers ---------------------------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = (p) => p + Math.random().toString(36).slice(2, 8);
const clone = (o) => JSON.parse(JSON.stringify(o));
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const sess = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
  del(k) { try { sessionStorage.removeItem(k); } catch {} },
};
function linkFor(code, admin) { return `${location.origin}/${code}${admin ? "/admin" : ""}`; }

// Pull a 6-character school code out of whatever was typed or pasted:
// "ABC123", "abc 123", "bus.stemstarters.com/ABC123", ".../ABC123/admin", "?code=ABC123"…
function extractCode(raw) {
  const txt = String(raw || "").trim();
  const m = /(?:^|[/=#?\s])([A-Za-z0-9]{3})[\s-]?([A-Za-z0-9]{3})(?=$|[/?#&\s.,!])/.exec(txt.replace(/^https?:\/\/[^/]+/i, "/"));
  return m ? (m[1] + m[2]).toUpperCase() : null;
}
function route() {
  const params = new URLSearchParams(location.search);
  let code = params.get("s") || params.get("code");
  let admin = params.has("admin");
  const parts = decodeURIComponent(location.pathname).split("/").map((p) => p.trim()).filter(Boolean);
  if (!code && parts[0]) {
    const c = extractCode("/" + parts[0]);
    if (c) { code = c; admin = admin || /^admin$/i.test(parts[1] || ""); }
  }
  if (!code && location.hash) code = extractCode("#" + location.hash.slice(1));
  code = code ? extractCode("/" + code) : null;
  const owner = !code && /^owner$/i.test(parts[0] || "");
  return { code, admin, owner };
}
function go(path) { history.pushState({}, "", path); boot(); }
window.addEventListener("popstate", () => boot());

/* ------------------------------ language ------------------------------ */
const T = {
  onTheWay: ["On the way", "En camino"],
  here: ["Here — wait for your call", "Llegó — esperen su turno"],
  goNow: ["GO NOW!", "¡YA!"],
  sent: ["Sent", "Enviado"],
  sendRiders: ["Send your riders down!", "¡Manden a sus estudiantes!"],
  bus: ["bus", "autobús"],
  tapToStart: ["Tap to start the classroom screen", "Toque para empezar"],
  pickGroup: ["Which students are in your class?", "¿Qué grados tiene su clase?"],
  allGroups: ["All groups (office view)", "Todos los grupos"],
  noBusesYet: ["No buses have arrived yet.", "Todavía no han llegado autobuses."],
  calledAt: ["Called at", "Llamado a las"],
  leftCampus: ["Left campus 👋", "Ya salió 👋"],
  leftAt: ["Left at", "Salió a las"],
};
function tr(key, lang) {
  const [en, es] = T[key];
  if (lang === "es") return esc(es);
  if (lang === "both") return `${esc(en)}<span class="sep"> · </span><span class="es">${esc(es)}</span>`;
  return esc(en);
}

/* ------------------------------- defaults ------------------------------ */
const THEMES = {
  STEMstarters: { primary: "#9246DD", accent: "#FC52B3", bg: "#fdf6e3" },
  Sunny:  { primary: "#ff9f1c", accent: "#2ec4b6", bg: "#fff8e7" },
  Ocean:  { primary: "#1d7ec2", accent: "#ffb703", bg: "#eaf6ff" },
  Garden: { primary: "#43aa8b", accent: "#f9844a", bg: "#f1faee" },
  Berry:  { primary: "#c9184a", accent: "#7b2cbf", bg: "#fff0f3" },
  Night:  { primary: "#7b5cff", accent: "#ffd166", bg: "#1b1d33" },
};
const COLOR_BUSES = [
  { name: "Red", color: "#e63946" },
  { name: "Green", color: "#43aa8b" },
  { name: "Yellow", color: "#ffd23f" },
  { name: "Orange", color: "#f77f00" },
];
function defaultSettings() {
  return {
    name: "",
    buses: COLOR_BUSES.map((b) => ({ id: uid("b"), ...b })),
    groups: ["K–1", "2–3", "4–5"].map((n) => ({ id: uid("g"), name: n })),
    theme: { ...THEMES.STEMstarters },
    chime: true,
    sound: "chime",
    lang: "en",
    message: "",
  };
}
function emptyState(version = 0) { return { version, day: today(), seq: 0, buses: {}, log: [] }; }
function liveState(state) {
  if (!state || state.day !== today()) return emptyState(state?.version || 0);
  return { seq: 0, buses: {}, log: [], ...state };
}

function applyTheme(theme) {
  const t = theme || THEMES.STEMstarters;
  const r = document.documentElement.style;
  r.setProperty("--primary", t.primary);
  r.setProperty("--accent", t.accent);
  r.setProperty("--bg", t.bg);
  // Pick readable text color for dark backgrounds
  const dark = luminance(t.bg) < 0.35;
  r.setProperty("--ink", dark ? "#f5f5ff" : "#2b2d42");
  r.setProperty("--card", dark ? "rgba(255,255,255,.08)" : "#ffffff");
  r.setProperty("--muted", dark ? "rgba(255,255,255,.65)" : "#6c6f85");
}
function luminance(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || "");
  if (!m) return 1;
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/* ------------------------- chip badge + header -------------------------- */
function chip(n, small = false) {
  return `<span class="nchip c${(n - 1) % 4}${small ? " sm" : ""}" aria-hidden="true"><b>${n}</b></span>`;
}
const STAR_SVG = `<svg class="istar" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.5l2.4 6.6 6.6 2.4-6.6 2.4L12 19.5l-2.4-6.6L3 10.5l6.6-2.4z" fill="#F8C631" stroke="#3A0F65" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
function wordmark() {
  const i = `<span class="si">ı${STAR_SVG}</span>`;
  return `<span class="wordmark" aria-label="Dismissal Magic"><span aria-hidden="true">D${i}sm${i}ssal Mag${i}c</span></span>`;
}
function headBlock({ pill = wordmark(), title, sub = "", right = "", left = "", compact = false, titleId = "" }) {
  return `<header class="head-block${compact ? " compact" : ""}">
    <span class="blob b1" aria-hidden="true"></span><span class="blob b2" aria-hidden="true"></span>
    <div class="head-text">
      ${left}
      ${pill ? `<span class="head-pill">${pill}</span>` : ""}
      <h1${titleId ? ` id="${titleId}"` : ""}>${title}</h1>
      ${sub ? `<p class="head-sub">${sub}</p>` : ""}
    </div>
    ${right ? `<div class="head-right">${right}</div>` : ""}
  </header>`;
}

/* ------------------------------- cute bus ------------------------------ */
function busSVG(color, cls = "") {
  const dark = luminance(color) < 0.3;
  const ink = "#2b2d42";
  const label = dark ? "#fff" : ink;
  const glass = "#dff3ff";
  return `<svg class="bus-svg ${cls}" viewBox="0 0 220 128" aria-hidden="true">
    <ellipse cx="112" cy="120" rx="98" ry="6" fill="rgba(0,0,0,.12)"/>
    <!-- roof warning lights -->
    <rect x="18" y="7" width="10" height="8" rx="2" fill="#ff5a5f" stroke="${ink}" stroke-width="2"/>
    <rect x="148" y="7" width="10" height="8" rx="2" fill="#ff5a5f" stroke="${ink}" stroke-width="2"/>
    <!-- hood -->
    <path d="M160 52 H196 Q208 54 210 66 V100 H160 Z" fill="${color}" stroke="${ink}" stroke-width="4" stroke-linejoin="round"/>
    <!-- main body -->
    <path d="M14 100 V24 Q14 13 26 13 H156 Q166 13 166 24 V100 Z" fill="${color}" stroke="${ink}" stroke-width="4" stroke-linejoin="round"/>
    <!-- windshield -->
    <path d="M158 22 Q164 22 165 28 L170 52 H158 Z" fill="${glass}" stroke="${ink}" stroke-width="3" stroke-linejoin="round"/>
    <!-- side windows -->
    ${[22, 45, 68, 91, 114].map((x) => `<rect x="${x}" y="22" width="19" height="22" rx="4" fill="${glass}" stroke="${ink}" stroke-width="3"/>`).join("")}
    <!-- door -->
    <rect x="137" y="22" width="18" height="74" rx="3" fill="${glass}" stroke="${ink}" stroke-width="3"/>
    <line x1="146" y1="22" x2="146" y2="96" stroke="${ink}" stroke-width="2.5"/>
    <!-- SCHOOL BUS lettering -->
    <text x="76" y="56.5" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="9.5" letter-spacing="1" fill="${label}">SCHOOL BUS</text>
    <!-- black rub rails -->
    <rect x="16" y="63" width="119" height="4" rx="1" fill="${ink}"/>
    <rect x="16" y="75" width="119" height="4" rx="1" fill="${ink}"/>
    <rect x="16" y="87" width="119" height="4" rx="1" fill="${ink}"/>
    <!-- stop arm -->
    <polygon points="122,48 128,48 132,52 132,58 128,62 122,62 118,58 118,52" fill="#e63946" stroke="#fff" stroke-width="1.5"/>
    <!-- face on hood -->
    <circle cx="180" cy="66" r="4.2" fill="${ink}"/><circle cx="193" cy="66" r="4.2" fill="${ink}"/>
    <circle cx="181.4" cy="64.5" r="1.5" fill="#fff"/><circle cx="194.4" cy="64.5" r="1.5" fill="#fff"/>
    <circle cx="175" cy="76" r="3.4" fill="#ff8fab" opacity=".85"/><circle cx="199" cy="76" r="3.4" fill="#ff8fab" opacity=".85"/>
    <path d="M181 75 Q186.5 81 192 75" fill="none" stroke="${ink}" stroke-width="2.6" stroke-linecap="round"/>
    <!-- headlight + bumpers -->
    <circle cx="206" cy="86" r="4.5" fill="#fff3b0" stroke="${ink}" stroke-width="2.5"/>
    <rect x="196" y="96" width="18" height="7" rx="3" fill="${ink}"/>
    <rect x="8" y="96" width="14" height="7" rx="3" fill="${ink}"/>
    <!-- wheels -->
    <g class="wheel"><circle cx="48" cy="102" r="15" fill="${ink}"/><circle cx="48" cy="102" r="6" fill="${dark ? "#bbb" : "#e9ecef"}"/></g>
    <g class="wheel"><circle cx="180" cy="102" r="15" fill="${ink}"/><circle cx="180" cy="102" r="6" fill="${dark ? "#bbb" : "#e9ecef"}"/></g>
  </svg>`;
}

/* -------------------------------- chime -------------------------------- */
let audioCtx = null;
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch {}
}
const SOUNDS = { chime: "Chime", horn: "Bus horn", bell: "School bell", none: "No sound" };
function soundOf(settings) { return settings.sound || (settings.chime === false ? "none" : "chime"); }
function playSound(kind) {
  if (!audioCtx || kind === "none") return;
  if (kind === "horn") return busHorn();
  if (kind === "bell") return schoolBell();
  chime(); setTimeout(chime, 1600);
}
// Two honks of a big two-tone horn
function busHorn() {
  const t0 = audioCtx.currentTime + 0.05;
  const out = audioCtx.createGain(); out.gain.value = 0.32;
  const lp = audioCtx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 1600; lp.Q.value = 0.8;
  lp.connect(out).connect(audioCtx.destination);
  [[0, 0.42], [0.55, 0.75]].forEach(([s, len]) => {
    [311.1, 392.0, 155.6].forEach((f, k) => {
      const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
      o.type = k === 2 ? "square" : "sawtooth"; o.frequency.value = f;
      o.frequency.setValueAtTime(f * 0.97, t0 + s); o.frequency.linearRampToValueAtTime(f, t0 + s + 0.06);
      const t = t0 + s;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(k === 2 ? 0.18 : 0.3, t + 0.03);
      g.gain.setValueAtTime(k === 2 ? 0.18 : 0.3, t + len - 0.05);
      g.gain.linearRampToValueAtTime(0, t + len);
      o.connect(g).connect(lp); o.start(t); o.stop(t + len + 0.02);
    });
  });
}
// Old-fashioned ringing school bell (fast hammer strikes), about 2 seconds
function schoolBell() {
  const t0 = audioCtx.currentTime + 0.05;
  const out = audioCtx.createGain(); out.gain.value = 0.22; out.connect(audioCtx.destination);
  for (let i = 0; i < 36; i++) {
    const t = t0 + i * 0.055;
    [[1320, 1], [3630, 0.45], [6900, 0.18]].forEach(([f, amp]) => {
      const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(amp, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.001, t + (i === 35 ? 1.2 : 0.16));
      o.connect(g).connect(out); o.start(t); o.stop(t + (i === 35 ? 1.25 : 0.18));
    });
  }
}
function chime() {
  if (!audioCtx) return;
  const notes = [1046.5, 1318.5, 1568.0, 2093.0]; // C6 E6 G6 C7
  const start = audioCtx.currentTime + 0.05;
  notes.forEach((f, i) => {
    [1, 2.01].forEach((mult, j) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = "sine";
      o.frequency.value = f * mult;
      const t = start + i * 0.18;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(j ? 0.05 : 0.22, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
      o.connect(g).connect(audioCtx.destination);
      o.start(t);
      o.stop(t + 1.3);
    });
  });
}

/* ================================ API ==================================
   Same interface for real (Supabase) and demo (this browser only).
   ======================================================================= */
let api;

function makeDemoApi() {
  const key = (c) => "busdemo:" + c;
  const bc = "BroadcastChannel" in window ? new BroadcastChannel("busdemo") : null;
  const listeners = new Map();
  function fire(code) { (listeners.get(code) || []).forEach((fn) => fn()); }
  bc && (bc.onmessage = (e) => fire(e.data));
  window.addEventListener("storage", (e) => { if (e.key && e.key.startsWith("busdemo:")) fire(e.key.slice(8)); });
  const load = (c) => store.get(key(c));
  const save = (c, v) => store.set(key(c), v);
  return {
    async createSchool(settings, pin) {
      if (!/^\d{4,8}$/.test(pin)) return { ok: false, error: "pin_format" };
      const alpha = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
      let code;
      do { code = Array.from({ length: 6 }, () => alpha[Math.floor(Math.random() * alpha.length)]).join(""); } while (load(code));
      save(code, { settings, state: { version: 0 }, pin });
      return { ok: true, code };
    },
    async findSchool(name, pin) {
      const norm = (x) => String(x || "").trim().replace(/\s+/g, " ").toLowerCase();
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k.startsWith("busdemo:")) continue;
        const v = store.get(k);
        if (v && norm(v.settings?.name) === norm(name) && v.pin === pin) out.push({ code: k.slice(8), name: v.settings.name });
      }
      return out.length ? { ok: true, schools: out } : { ok: false, error: "no_match" };
    },
    async deleteSchool(code, pin, name) {
      const s = load(code);
      if (!s) return { ok: false, error: "not_found" };
      if (s.pin !== pin) return { ok: false, error: "bad_pin" };
      const norm = (x) => String(x || "").trim().replace(/\s+/g, " ").toLowerCase();
      if (norm(name) !== norm(s.settings?.name)) return { ok: false, error: "name_mismatch" };
      store.del(key(code));
      return { ok: true };
    },
    async schoolStats(code) {
      const days = [];
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith("busdemo-stats:" + code + ":")) days.push(k.split(":")[2]); }
      days.sort();
      return { ok: true, dismissals: days.length, first_day: days[0] || null };
    },
    async ownerStats(key, days = 30) {
      if (key !== "demo") return { ok: false, error: "bad_key" };
      const rows = [], schools = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.startsWith("busdemo-stats:")) { const [, c, day] = k.split(":"); rows.push({ code: c, day, ...store.get(k) }); }
        if (k.startsWith("busdemo:")) { const v = store.get(k); schools.push({ code: k.slice(8), name: v?.settings?.name, buses: v?.settings?.buses?.length || 0 }); }
      }
      const t = today(), ago = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
      const wk = ago(6);
      const daily = Array.from({ length: days }, (_, i) => { const day = ago(days - 1 - i); const r = rows.filter((x) => x.day === day); return { day, dismissals: r.length, calls: r.reduce((a, x) => a + (x.calls || 0), 0) }; });
      return { ok: true, today: t, totals: {
        schools: schools.length, new_schools_7d: schools.length, dismissals: rows.length,
        dismissals_7d: rows.filter((x) => x.day >= wk).length, active_schools_7d: new Set(rows.filter((x) => x.day >= wk).map((x) => x.code)).size,
        buses_arrived: rows.reduce((a, x) => a + (x.arrived || 0), 0), group_calls: rows.reduce((a, x) => a + (x.calls || 0), 0),
        first_day: rows.map((x) => x.day).sort()[0] || null },
        daily, schools: schools.map((sc) => { const r = rows.filter((x) => x.code === sc.code); return { ...sc, dismissals: r.length, last_day: r.map((x) => x.day).sort().pop() || null, group_calls: r.reduce((a, x) => a + (x.calls || 0), 0) }; }) };
    },
    async getSchool(code) { const s = load(code); return s ? { code, settings: s.settings, state: s.state } : null; },
    async checkPin(code, pin) { const s = load(code); if (!s) return { ok: false, error: "not_found" }; return s.pin === pin ? { ok: true } : { ok: false, error: "bad_pin" }; },
    async saveState(code, pin, state, expected) {
      const s = load(code);
      if (!s) return { ok: false, error: "not_found" };
      if (s.pin !== pin) return { ok: false, error: "bad_pin" };
      if ((s.state.version || 0) !== expected) return { ok: false, error: "conflict", state: s.state };
      s.state = { ...state, version: expected + 1 };
      const sum = daySummary(s.state);
      if (sum) {
        const k = "busdemo-stats:" + code + ":" + s.state.day;
        const old = store.get(k) || {};
        store.set(k, { arrived: Math.max(old.arrived || 0, sum.arrived), calls: Math.max(old.calls || 0, sum.calls), left: Math.max(old.left || 0, sum.left) });
      }
      save(code, s);
      return { ok: true, state: s.state };
    },
    async saveSettings(code, pin, settings, newPin) {
      const s = load(code);
      if (!s) return { ok: false, error: "not_found" };
      if (s.pin !== pin) return { ok: false, error: "bad_pin" };
      if (newPin) { if (!/^\d{4,8}$/.test(newPin)) return { ok: false, error: "pin_format" }; s.pin = newPin; }
      s.settings = settings;
      save(code, s);
      return { ok: true };
    },
    subscribe(code, fn) {
      if (!listeners.has(code)) listeners.set(code, []);
      listeners.get(code).push(fn);
      return () => listeners.set(code, (listeners.get(code) || []).filter((f) => f !== fn));
    },
    notify(code) { bc && bc.postMessage(code); },
  };
}

async function makeSupabaseApi() {
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
  const sb = createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, { auth: { persistSession: false } });
  const channels = new Map();
  async function rpc(fn, args) {
    const { data, error } = await sb.rpc(fn, args);
    if (error) { console.error(error); return { ok: false, error: "network" }; }
    return data;
  }
  function channel(code) {
    if (!channels.has(code)) {
      const ch = sb.channel("bus-" + code, { config: { broadcast: { self: false } } });
      const entry = { ch, fns: [] };
      ch.on("broadcast", { event: "changed" }, () => entry.fns.forEach((f) => f()));
      ch.subscribe((status) => { if (status === "SUBSCRIBED") entry.fns.forEach((f) => f()); });
      channels.set(code, entry);
    }
    return channels.get(code);
  }
  return {
    createSchool: (settings, pin) => rpc("bus_create_school", { p_settings: settings, p_pin: pin }),
    async getSchool(code) {
      const { data, error } = await sb.rpc("bus_get_school", { p_code: code });
      if (error) throw error;
      return data;
    },
    checkPin: (code, pin) => rpc("bus_check_pin", { p_code: code, p_pin: pin }),
    findSchool: (name, pin) => rpc("bus_find_school", { p_name: name, p_pin: pin }),
    ownerStats: (key, days) => rpc("bus_owner_stats", { p_key: key, p_days: days }),
    schoolStats: (code) => rpc("bus_school_stats", { p_code: code }),
    deleteSchool: (code, pin, name) => rpc("bus_delete_school", { p_code: code, p_pin: pin, p_confirm_name: name }),
    saveState: (code, pin, state, expected) => rpc("bus_save_state", { p_code: code, p_pin: pin, p_state: state, p_expected_version: expected }),
    saveSettings: (code, pin, settings, newPin) => rpc("bus_save_settings", { p_code: code, p_pin: pin, p_settings: settings, p_new_pin: newPin || null }),
    subscribe(code, fn) {
      const e = channel(code);
      e.fns.push(fn);
      return () => { e.fns = e.fns.filter((f) => f !== fn); };
    },
    // The broadcast is only a "something changed" ping; screens always re-read
    // the real data from the database, so a fake ping can't fake a bus call.
    notify(code) { channel(code).ch.send({ type: "broadcast", event: "changed", payload: {} }); },
  };
}

const ERRORS = {
  bad_pin: "That PIN didn't match.",
  locked: "Too many wrong PINs. The master panel is locked for 15 minutes.",
  not_found: "We couldn't find that school code.",
  pin_format: "The PIN must be 4–8 digits (numbers only).",
  network: "Couldn't reach the server. Check the internet connection and try again.",
  settings_invalid: "Those settings couldn't be saved.",
};

/* ------------------------------- live feed ----------------------------- */
// Keeps one school's data fresh: realtime pings + a 20s safety refresh.
function liveSchool(code, onData) {
  let stopped = false, timer = null, pending = false, running = false;
  async function refresh() {
    if (stopped) return;
    if (running) { pending = true; return; }
    running = true;
    try {
      const s = await api.getSchool(code);
      if (!stopped) onData(s, null);
    } catch (e) {
      if (!stopped) onData(null, e);
    }
    running = false;
    if (pending) { pending = false; refresh(); }
  }
  const unsub = api.subscribe(code, refresh);
  timer = setInterval(refresh, 20000);
  const vis = () => { if (!document.hidden) refresh(); };
  document.addEventListener("visibilitychange", vis);
  window.addEventListener("online", refresh);
  refresh();
  return {
    refresh,
    stop() { stopped = true; unsub(); clearInterval(timer); document.removeEventListener("visibilitychange", vis); window.removeEventListener("online", refresh); },
  };
}

/* ============================== STATE OPS ============================== */
function applyOp(stateIn, op, settings) {
  const s = clone(liveState(stateIn));
  const now = Date.now();
  const busOf = (id) => (s.buses[id] = s.buses[id] || { arrived: null, called: {} });
  const log = (e) => { s.seq += 1; s.log.push({ seq: s.seq, at: now, ...e }); s.log = s.log.slice(-60); };
  switch (op.type) {
    case "arrive": { const b = busOf(op.bus); if (b.arrived) return null; b.arrived = now; log({ type: "arrive", bus: op.bus }); break; }
    case "unarrive": { delete s.buses[op.bus]; log({ type: "unarrive", bus: op.bus }); break; }
    case "call": {
      const b = busOf(op.bus);
      b.arrived = b.arrived || now;
      b.called[op.group] = now;
      log({ type: "call", bus: op.bus, group: op.group });
      break;
    }
    case "leave": { const b = busOf(op.bus); b.arrived = b.arrived || now; if (b.left) return null; b.left = now; log({ type: "leave", bus: op.bus }); break; }
    case "unleave": { const b = busOf(op.bus); if (!b.left) return null; delete b.left; log({ type: "unleave", bus: op.bus }); break; }
    case "uncall": { const b = busOf(op.bus); delete b.called[op.group]; log({ type: "uncall", bus: op.bus, group: op.group }); break; }
    case "callGroup": {
      const ids = settings.buses.map((b) => b.id).filter((id) => s.buses[id]?.arrived && !s.buses[id].left && !s.buses[id].called[op.group]);
      if (!ids.length) return null;
      ids.forEach((id) => { s.buses[id].called[op.group] = now; log({ type: "call", bus: id, group: op.group }); });
      break;
    }
    case "reset": { return { ...emptyState(s.version), seq: s.seq }; }
    default: return null;
  }
  return s;
}

/* ================================ BOOT ================================= */
let cleanup = () => {};
/* ---------------- moving from bus.stemstarters.com ---------------- */
// Old address → new address. Settings saved in this browser (teacher's group,
// waiting video, remembered schools) ride along in the #hash, which is never sent
// to any server. PINs are NOT carried over; people just type them once more.
const NEW_HOST = "app.dismissalmagic.com";
const OLD_HOSTS = ["bus.stemstarters.com"];
const CARRY_PREFIXES = ["busgroup:", "busvideo:", "busrecent"];
function importCarried() {
  const m = /(?:^#|&)carry=([^&]+)/.exec(location.hash);
  if (!m) return;
  try {
    const data = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(m[1])))));
    for (const [k, v] of Object.entries(data)) {
      if (!CARRY_PREFIXES.some((p) => k.startsWith(p))) continue;
      if (k === "busrecent") {
        const mine = store.get("busrecent") || [];
        const merged = [...mine, ...(JSON.parse(v) || [])].filter((x, i, arr) => x && arr.findIndex((y) => y.code === x.code) === i);
        store.set("busrecent", merged.slice(0, 12));
      } else if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
    }
  } catch {}
  history.replaceState({}, "", location.pathname + location.search);
}
async function moveToNewHost() {
  if (!OLD_HOSTS.includes(location.hostname)) return false;
  // Only move if the new address actually loads here (e.g. not blocked by a school web filter).
  const ok = await Promise.race([
    fetch(`https://${NEW_HOST}/favicon.svg?ping=${Date.now()}`, { mode: "no-cors", cache: "no-store" }).then(() => true, () => false),
    new Promise((r) => setTimeout(() => r(false), 4000)),
  ]);
  if (!ok) return false;
  const carry = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (CARRY_PREFIXES.some((p) => k.startsWith(p))) carry[k] = localStorage.getItem(k);
    }
  } catch {}
  const hash = Object.keys(carry).length ? "#carry=" + encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(carry))))) : location.hash;
  location.replace(`https://${NEW_HOST}${location.pathname}${location.search}${hash}`);
  return true;
}

let moving = null;
async function boot() {
  if (moving === null) {
    $app.innerHTML = `<div class="loading">🚌 Loading…</div>`;
    moving = await moveToNewHost();
    importCarried();
  }
  if (moving) return;
  cleanup(); cleanup = () => {};
  closeModal();
  if (!api) api = DEMO ? makeDemoApi() : await makeSupabaseApi().catch((e) => { console.error(e); return null; });
  if (!api) { $app.innerHTML = `<div class="center-card card"><h2>Couldn't load</h2><p>Check your internet connection and refresh.</p></div>`; return; }
  const r = route();
  if (r.owner) return renderOwner();
  if (!r.code) return renderHome();
  if (r.admin) return renderAdmin(r.code);
  return renderDisplay(r.code);
}

function demoBanner() {
  return DEMO ? `<div class="demo-banner">Demo mode — data stays in this browser only. Open a second tab to see live updates. Add your Supabase keys in <code>config.js</code> to go live.</div>` : "";
}

/* ================================ HOME ================================= */
/* ------------------- schools remembered on this device ------------------ */
function rememberSchool(code, name) {
  if (!code) return;
  const list = (store.get("busrecent") || []).filter((x) => x.code !== code);
  list.unshift({ code, name: name || "", at: Date.now() });
  store.set("busrecent", list.slice(0, 12));
}
function forgetSchool(code) { store.set("busrecent", (store.get("busrecent") || []).filter((x) => x.code !== code)); }

function renderHome() {
  applyTheme(THEMES.STEMstarters);
  document.title = "Dismissal Magic — quiet bus calls for every classroom";
  $app.innerHTML = `
    ${demoBanner()}
    <div class="home">
      ${headBlock({ pill: "For schools", title: wordmark(), sub: "Quiet bus calls, like magic. Call buses by grade. Classroom screens light up so teachers know exactly when to send riders down. No intercom needed.", right: `<div class="head-bus">${busSVG("#ffd23f", "drive-in")}</div>` })}
      <div class="home-grid">
        <div class="card step s1">
          <h2>Have a school code?</h2>
          <form id="join" class="stack">
            <label class="sr" for="join-code">School code or link</label><input id="join-code" class="code-input" maxlength="80" placeholder="ABC123" autocomplete="off" autocapitalize="characters" spellcheck="false" />
            <div class="row">
              <button class="btn primary" type="submit">Open classroom screen</button>
              <button class="btn" type="button" id="join-admin">Master panel</button>
            </div>
            <p class="err" id="join-err"></p>
          </form>
        </div>
        <div class="card step s2">
          <h2>Set up your school</h2>
          <p class="muted">Pick your buses, how you call grades, and your colors. You'll get a school code and links to share.</p>
          <button class="btn primary big" id="start-setup">Create a school</button>
        </div>
      </div>
      ${(() => {
        const recent = store.get("busrecent") || [];
        if (!recent.length) return "";
        return `<section class="card step s3 recent-card">
          <h2>Your schools on this device</h2>
          <div class="recent-list">${recent.map((r) => `
            <div class="recent-row">
              <div class="recent-name"><b>${esc(r.name || "School")}</b><span class="recent-code">${esc(r.code)}</span></div>
              <div class="row">
                <a class="btn small" href="/${esc(r.code)}">Classroom screen</a>
                <a class="btn small primary" href="/${esc(r.code)}/admin">Master panel</a>
                <button class="icon-btn" type="button" data-forget="${esc(r.code)}" aria-label="Remove ${esc(r.name || r.code)} from this list"><svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg></button>
              </div>
            </div>`).join("")}</div>
        </section>`;
      })()}
      <section class="card step s4 find-card">
        <h2>Forgot your school code?</h2>
        <p class="muted">Type your school name exactly as you set it up, plus your master panel PIN.</p>
        <form id="find" class="find-form">
          <label>School name<input id="find-name" autocomplete="organization" placeholder="e.g. Sunnyside Elementary" required /></label>
          <label>PIN<input id="find-pin" type="password" inputmode="numeric" autocomplete="current-password" required /></label>
          <button class="btn primary" type="submit">Find my code</button>
        </form>
        <p class="err" id="find-err"></p>
        <div id="find-result"></div>
      </section>
      <footer class="app-foot">© 2026 STEMstarters LLC · <a href="https://dismissalmagic.com/privacy">Privacy Policy</a> · <a href="https://dismissalmagic.com/terms">Terms of Service</a></footer>
    </div>`;
  document.querySelectorAll("[data-forget]").forEach((b) => (b.onclick = () => { forgetSchool(b.dataset.forget); renderHome(); }));
  document.querySelectorAll(".recent-row a").forEach((a) => (a.onclick = (e) => { e.preventDefault(); go(a.getAttribute("href")); }));
  document.getElementById("find").onsubmit = async (e) => {
    e.preventDefault();
    const err = document.getElementById("find-err"), out = document.getElementById("find-result");
    err.textContent = ""; out.innerHTML = "";
    const name = document.getElementById("find-name").value.trim();
    const pin = document.getElementById("find-pin").value.trim();
    const r = await api.findSchool(name, pin);
    if (!r?.ok) { err.textContent = r?.error === "locked" ? ERRORS.locked : r?.error === "no_match" ? "No school matched that name and PIN. Check the spelling of the school name." : (ERRORS[r?.error] || ERRORS.network); return; }
    r.schools.forEach((x) => rememberSchool(x.code, x.name));
    out.innerHTML = r.schools.map((x) => `<div class="share-row found"><div><b>${esc(x.name)}</b><div class="big-code">${esc(x.code)}</div></div>
      <div class="row"><a class="btn small" href="/${esc(x.code)}">Classroom screen</a><a class="btn small primary" href="/${esc(x.code)}/admin">Master panel</a></div></div>`).join("");
    out.querySelectorAll("a").forEach((a) => (a.onclick = (ev) => { ev.preventDefault(); sess.set("buspin:" + a.getAttribute("href").split("/")[1], pin); go(a.getAttribute("href")); }));
  };
  const codeEl = document.getElementById("join-code");
  async function open(admin) {
    const err = document.getElementById("join-err");
    const code = extractCode("/" + codeEl.value.trim().replace(/^\/+/, ""));
    if (!code) { err.textContent = "Type the 6-letter school code (or paste the link)."; return; }
    if (/admin/i.test(codeEl.value)) admin = true;
    let s = null;
    try { s = await api.getSchool(code); } catch { err.textContent = ERRORS.network; return; }
    if (!s) { err.textContent = ERRORS.not_found; return; }
    go(`/${code}${admin ? "/admin" : ""}`);
  }
  document.getElementById("join").onsubmit = (e) => { e.preventDefault(); open(false); };
  document.getElementById("join-admin").onclick = () => open(true);
  document.getElementById("start-setup").onclick = () => renderSetup();
}

/* =========================== SETTINGS EDITOR =========================== */
// Used both for "Create a school" and for editing from the master panel.
function settingsEditor(container, initial, { mode, onSubmit, onCancel, onDelete }) {
  const st = clone(initial);
  function render() {
    applyTheme(st.theme);
    container.innerHTML = `
      <form class="settings" id="settings-form">
        <section class="card step s1">
          <h2>${chip(1)} Your school</h2>
          <label>School name<input id="s-name" value="${esc(st.name)}" placeholder="e.g. Sunnyside Elementary" required /></label>
          <label><span>A note for teachers <span class="muted">(optional)</span></span><input id="s-msg" value="${esc(st.message)}" placeholder="Walk, don't run! 🚶" /></label>
        </section>

        <section class="card step s2">
          <h2>${chip(2)} Your buses</h2>
          <div class="row wrap">
            <button type="button" class="btn small" id="preset-colors">Color buses (Red, Green, Yellow, Orange)</button>
            <span class="row nowrap">
              <input type="number" id="num-count" min="1" max="60" value="${Math.max(st.buses.length, 1)}" class="tiny" />
              <button type="button" class="btn small" id="preset-numbers">Numbered buses</button>
            </span>
          </div>
          <div class="list" id="bus-list">
            ${st.buses.map((b, i) => `
              <div class="list-row">
                <span class="mini-bus">${busSVG(b.color)}</span>
                <input type="color" data-bcolor="${i}" value="${esc(b.color)}" title="Bus color" />
                <input data-bname="${i}" value="${esc(b.name)}" placeholder="Bus name or number" required />
                <button type="button" class="icon-btn" data-bdel="${i}" title="Remove">✕</button>
              </div>`).join("")}
          </div>
          <button type="button" class="btn small" id="add-bus">+ Add a bus</button>
        </section>

        <section class="card step s3">
          <h2>${chip(3)} Calling order</h2>
          <p class="muted">First group called is #1. Teachers pick their group on the classroom screen.</p>
          <div class="row wrap">
            <button type="button" class="btn small" data-gpreset="pairs">K–1 · 2–3 · 4–5</button>
            <button type="button" class="btn small" data-gpreset="grades">K · 1 · 2 · 3 · 4 · 5</button>
            <button type="button" class="btn small" data-gpreset="all">Everyone at once</button>
          </div>
          <div class="list" id="group-list">
            ${st.groups.map((g, i) => `
              <div class="list-row">
                ${chip(i + 1, true)}
                <input data-gname="${i}" value="${esc(g.name)}" required />
                <button type="button" class="icon-btn" data-gup="${i}" title="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
                <button type="button" class="icon-btn" data-gdel="${i}" title="Remove">✕</button>
              </div>`).join("")}
          </div>
          <button type="button" class="btn small" id="add-group">+ Add a group</button>
        </section>

        <section class="card step s4">
          <h2>${chip(4)} Colors &amp; sound</h2>
          <div class="row wrap">
            ${Object.entries(THEMES).map(([n, t]) => `<button type="button" class="swatch" data-theme="${n}" style="background:${t.bg};border-color:${t.primary}"><span style="background:${t.primary}"></span><span style="background:${t.accent}"></span>${n}</button>`).join("")}
          </div>
          <div class="row wrap">
            <label class="color-pick">Main<input type="color" id="t-primary" value="${esc(st.theme.primary)}" /></label>
            <label class="color-pick">Accent<input type="color" id="t-accent" value="${esc(st.theme.accent)}" /></label>
            <label class="color-pick">Background<input type="color" id="t-bg" value="${esc(st.theme.bg)}" /></label>
          </div>
          <label for="s-sound">Sound when a group is called</label>
          <div class="row nowrap sound-row">
            <select id="s-sound">${Object.entries(SOUNDS).map(([k, v]) => `<option value="${k}" ${soundOf(st) === k ? "selected" : ""}>${v}</option>`).join("")}</select>
            <button type="button" class="btn" id="s-test">▶ Try it</button>
          </div>
          <label>Classroom screen language
            <select id="s-lang">
              <option value="en" ${st.lang === "en" ? "selected" : ""}>English</option>
              <option value="es" ${st.lang === "es" ? "selected" : ""}>Español</option>
              <option value="both" ${st.lang === "both" ? "selected" : ""}>English + Español</option>
            </select>
          </label>
        </section>

        <section class="card step s5 wide">
          <h2>${chip(5)} Secret PIN for bus helpers</h2>
          <p class="muted">Anyone with this PIN can call buses. Share it with your backups.</p>
          ${mode === "edit" ? `<p class="muted">Leave blank to keep the current PIN.</p>` : ""}
          <div class="row wrap">
            <label>PIN (4–8 numbers)<input id="s-pin" inputmode="numeric" pattern="[0-9]{4,8}" ${mode === "create" ? "required" : ""} autocomplete="new-password" type="password" /></label>
            <label>Type it again<input id="s-pin2" inputmode="numeric" type="password" autocomplete="new-password" /></label>
          </div>
        </section>

        ${mode === "edit" && onDelete ? `<section class="card danger-zone wide">
          <h2>Delete this school</h2>
          <p class="muted">Permanently removes this school's name, buses, settings and PIN. Classroom links and the master panel stop working right away. This can't be undone.</p>
          <div><button type="button" class="btn danger" id="s-delete">Delete this school…</button></div>
        </section>` : ""}
        <div class="settings-foot wide">
        <p class="err" id="s-err"></p>
        <div class="row center">
          <button class="btn primary huge" type="submit">${mode === "create" ? "Create my school" : "Save changes"}</button>
          <button class="btn" type="button" id="s-cancel">Cancel</button>
        </div>
        </div>
      </form>`;
    wire();
  }
  function readInputs() {
    const f = container;
    st.name = f.querySelector("#s-name").value.trim();
    st.message = f.querySelector("#s-msg").value.trim();
    f.querySelectorAll("[data-bname]").forEach((el) => (st.buses[+el.dataset.bname].name = el.value.trim()));
    f.querySelectorAll("[data-bcolor]").forEach((el) => (st.buses[+el.dataset.bcolor].color = el.value));
    f.querySelectorAll("[data-gname]").forEach((el) => (st.groups[+el.dataset.gname].name = el.value.trim()));
    st.theme = { primary: f.querySelector("#t-primary").value, accent: f.querySelector("#t-accent").value, bg: f.querySelector("#t-bg").value };
    st.sound = f.querySelector("#s-sound").value;
    st.chime = st.sound !== "none";
    st.lang = f.querySelector("#s-lang").value;
  }
  function wire() {
    const q = (s) => container.querySelector(s);
    const rerender = (fn) => () => { readInputs(); fn(); render(); };
    q("#add-bus").onclick = rerender(() => st.buses.push({ id: uid("b"), name: "", color: "#ffc300" }));
    q("#preset-colors").onclick = rerender(() => (st.buses = COLOR_BUSES.map((b) => ({ id: uid("b"), ...b }))));
    q("#preset-numbers").onclick = rerender(() => {
      const n = Math.min(60, Math.max(1, parseInt(q("#num-count").value, 10) || 1));
      st.buses = Array.from({ length: n }, (_, i) => ({ id: uid("b"), name: String(i + 1), color: "#ffc300" }));
    });
    container.querySelectorAll("[data-bdel]").forEach((el) => (el.onclick = rerender(() => st.buses.splice(+el.dataset.bdel, 1))));
    container.querySelectorAll("[data-bcolor]").forEach((el) => (el.oninput = () => {
      const row = el.closest(".list-row");
      row.querySelector(".mini-bus").innerHTML = busSVG(el.value);
    }));
    q("#add-group").onclick = rerender(() => st.groups.push({ id: uid("g"), name: "" }));
    container.querySelectorAll("[data-gdel]").forEach((el) => (el.onclick = rerender(() => st.groups.splice(+el.dataset.gdel, 1))));
    container.querySelectorAll("[data-gup]").forEach((el) => (el.onclick = rerender(() => {
      const i = +el.dataset.gup; [st.groups[i - 1], st.groups[i]] = [st.groups[i], st.groups[i - 1]];
    })));
    container.querySelectorAll("[data-gpreset]").forEach((el) => (el.onclick = rerender(() => {
      const p = { pairs: ["K–1", "2–3", "4–5"], grades: ["K", "1st", "2nd", "3rd", "4th", "5th"], all: ["Everyone"] }[el.dataset.gpreset];
      st.groups = p.map((n) => ({ id: uid("g"), name: n }));
    })));
    container.querySelectorAll("[data-theme]").forEach((el) => (el.onclick = rerender(() => (st.theme = { ...THEMES[el.dataset.theme] }))));
    ["#t-primary", "#t-accent", "#t-bg"].forEach((s) => (q(s).oninput = () => { readInputs(); applyTheme(st.theme); }));
    q("#s-cancel").onclick = onCancel;
    if (q("#s-delete")) q("#s-delete").onclick = () => onDelete(initial.name);
    q("#s-test").onclick = () => { unlockAudio(); playSound(q("#s-sound").value); };
    q("#settings-form").onsubmit = async (e) => {
      e.preventDefault();
      readInputs();
      const err = q("#s-err");
      const pin = q("#s-pin").value.trim(), pin2 = q("#s-pin2").value.trim();
      if (!st.name) return (err.textContent = "Add your school name.");
      if (!st.buses.length) return (err.textContent = "Add at least one bus.");
      if (st.buses.some((b) => !b.name)) return (err.textContent = "Every bus needs a name or number.");
      if (!st.groups.length) return (err.textContent = "Add at least one group.");
      if (st.groups.some((g) => !g.name)) return (err.textContent = "Every group needs a name.");
      if (mode === "create" || pin) {
        if (!/^\d{4,8}$/.test(pin)) return (err.textContent = ERRORS.pin_format);
        if (pin !== pin2) return (err.textContent = "The two PINs don't match.");
      }
      err.textContent = "";
      const btn = q("button[type=submit]");
      btn.disabled = true;
      const msg = await onSubmit(clone(st), pin);
      btn.disabled = false;
      if (msg) err.textContent = msg;
    };
  }
  render();
}

function renderSetup() {
  $app.innerHTML = `${demoBanner()}<div class="page">${headBlock({ left: `<button class="btn small light back" id="back">← Back</button>`, title: "Set up your school", sub: "5 easy steps, then call your buses!", right: `<div class="head-bus">${busSVG("#ffd23f", "drive-in")}</div>` })}<div id="editor"></div></div>`;
  document.getElementById("back").onclick = () => renderHome();
  settingsEditor(document.getElementById("editor"), defaultSettings(), {
    mode: "create",
    onCancel: () => renderHome(),
    async onSubmit(settings, pin) {
      const r = await api.createSchool(settings, pin);
      if (!r?.ok) return ERRORS[r?.error] || ERRORS.network;
      sess.set("buspin:" + r.code, pin);
      rememberSchool(r.code, settings.name);
      renderCreated(r.code, settings);
    },
  });
}

function shareBlock(code) {
  return `
    <div class="share">
      <div class="share-row"><div><b>School code</b><div class="big-code">${esc(code)}</div></div></div>
      <div class="share-row"><div><b>Classroom screen link</b> — send to teachers<div class="link">${esc(linkFor(code, false))}</div></div><button class="btn small" data-copy="${esc(linkFor(code, false))}">Copy</button></div>
      <div class="share-row"><div><b>Master panel link</b> — for you and your backups (needs the PIN)<div class="link">${esc(linkFor(code, true))}</div></div><button class="btn small" data-copy="${esc(linkFor(code, true))}">Copy</button></div>
    </div>`;
}
function wireCopy(root) {
  root.querySelectorAll("[data-copy]").forEach((b) => (b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "Copied!"; }
    catch { prompt("Copy this link:", b.dataset.copy); }
    setTimeout(() => (b.textContent = "Copy"), 1500);
  }));
}

function renderCreated(code, settings) {
  applyTheme(settings.theme);
  $app.innerHTML = `${demoBanner()}
    <div class="center-card card created">
      <div class="hero-bus">${busSVG(settings.buses[0]?.color || "#ffd23f", "drive-in")}</div>
      <h1>${esc(settings.name)} is ready! 🎉</h1>
      ${shareBlock(code)}
      <div class="row">
        <button class="btn primary big" id="to-admin">Open master panel</button>
        <button class="btn big" id="to-display">Preview classroom screen</button>
      </div>
    </div>`;
  wireCopy($app);
  document.getElementById("to-admin").onclick = () => go(`/${code}/admin`);
  document.getElementById("to-display").onclick = () => window.open(`/${code}`, "_blank");
}

/* ============================ MASTER PANEL ============================= */
function renderAdmin(code) {
  const pinKey = "buspin:" + code;
  const pin = sess.get(pinKey) || store.get(pinKey);
  if (pin) return adminPanel(code, pin);
  applyTheme(THEMES.STEMstarters);
  $app.innerHTML = `${demoBanner()}
    <div class="center-card card">
      <div class="hero-bus small">${busSVG("#ffd23f")}</div>
      <h1>Master panel</h1>
      <p class="muted">School code <b>${esc(code)}</b></p>
      <form id="pin-form" class="stack">
        <input id="pin" class="code-input" type="password" inputmode="numeric" placeholder="PIN" autocomplete="current-password" autofocus />
        <label class="check"><input type="checkbox" id="remember" /> Keep me signed in on this device</label>
        <button class="btn primary big" type="submit">Sign in</button>
        <p class="err" id="pin-err"></p>
      </form>
      <p><a href="/" class="muted">← Home</a></p>
    </div>`;
  api.getSchool(code).then((s) => {
    if (!s) document.getElementById("pin-err").textContent = ERRORS.not_found;
    else applyTheme(s.settings.theme);
  }).catch(() => {});
  document.getElementById("pin-form").onsubmit = async (e) => {
    e.preventDefault();
    const p = document.getElementById("pin").value.trim();
    const r = await api.checkPin(code, p);
    if (!r?.ok) { document.getElementById("pin-err").textContent = ERRORS[r?.error] || ERRORS.network; return; }
    sess.set(pinKey, p);
    if (document.getElementById("remember").checked) store.set(pinKey, p);
    adminPanel(code, p);
  };
}

function adminPanel(code, pin) {
  let school = null;
  let busy = false;
  const signOut = () => { sess.del("buspin:" + code); store.del("buspin:" + code); feed.stop(); renderAdmin(code); };

  const feed = liveSchool(code, (s, err) => {
    if (err) { setStatus("offline"); return; }
    if (!s) { $app.innerHTML = `<div class="center-card card"><h2>${ERRORS.not_found}</h2><a href="/">Home</a></div>`; return; }
    setStatus("live");
    if (!school) rememberSchool(code, s.settings.name);
    school = s;
    if (!document.getElementById("admin-root")) { shell(); loadCount(); }
    draw();
  });
  cleanup = () => feed.stop();

  function setStatus(s) {
    const el = document.getElementById("live-dot");
    if (el) { el.className = "live-dot " + s; el.title = s === "live" ? "Connected" : "Reconnecting…"; }
  }

  async function act(op) {
    if (busy || !school) return;
    busy = true;
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const base = liveState(school.state);
        const next = applyOp(base, op, school.settings);
        if (!next) return;
        const r = await api.saveState(code, pin, next, base.version || 0);
        if (r?.ok) { school.state = r.state; draw(); api.notify(code); loadCountSoon(); return; }
        if (r?.error === "conflict") { school.state = r.state; continue; }
        if (r?.error === "bad_pin" || r?.error === "locked") { alert(ERRORS[r.error] + " Please sign in again."); signOut(); return; }
        toast(ERRORS[r?.error] || ERRORS.network);
        return;
      }
      toast("Someone else is busy on the panel — try again.");
    } finally { busy = false; }
  }

  let countTimer = null;
  function loadCountSoon() { clearTimeout(countTimer); countTimer = setTimeout(loadCount, 1500); }
  async function loadCount() {
    const el = document.getElementById("magic-strip");
    if (!el) return;
    let r = null;
    try { r = await api.schoolStats(code); } catch {}
    if (!r?.ok) { el.hidden = true; return; }
    el.hidden = false;
    const n = r.dismissals || 0;
    el.innerHTML = n
      ? `<span class="magic-num">${fmtNum(n)}</span><span class="magic-txt">Magic Dismissal${n === 1 ? "" : "s"} ✨</span><span class="muted small">${r.first_day ? `since ${fmtDay(r.first_day, { month: "long", day: "numeric", year: "numeric" })}` : ""}</span>`
      : `<span class="magic-txt">✨ Your first Magic Dismissal starts when you mark a bus arrived.</span>`;
  }

  function shell() {
    $app.innerHTML = `${demoBanner()}
      <div class="page admin" id="admin-root">
        ${headBlock({ compact: true, pill: `<span id="live-dot" class="live-dot live"></span> Master panel · ${esc(code)}`, title: "", titleId: "a-title", right: `<div class="row">
            <button class="btn small light" id="a-share">Share links</button>
            <button class="btn small light" id="a-settings">Settings</button>
            <button class="btn small light" id="a-out">Sign out</button>
          </div>` })}
        <section class="magic-strip" id="magic-strip" aria-live="polite"></section>
        <section class="group-bar" id="group-bar"></section>
        <section class="bus-grid" id="bus-grid"></section>
        <section class="card step s3 log-card">
          <div class="row spread"><h2>Today</h2><button class="btn small danger" id="a-reset">Reset for a new day</button></div>
          <ol class="log" id="log"></ol>
        </section>
      </div>`;
    document.getElementById("a-out").onclick = signOut;
    document.getElementById("a-share").onclick = () => {
      openModal(`<h2>Share</h2>${shareBlock(code)}<p class="muted">Teachers only need the classroom link. Backups need the master link <i>and</i> the PIN.</p><div class="row"><button class="btn" data-close>Done</button></div>`);
      wireCopy($modal);
    };
    document.getElementById("a-reset").onclick = () => confirmModal("Clear all of today's arrivals and calls?", "Reset", () => act({ type: "reset" }));
    document.getElementById("a-settings").onclick = () => {
      feed.stop();
      $app.innerHTML = `${demoBanner()}<div class="page">${headBlock({ pill: "Master panel", title: "Settings", sub: esc(school.settings.name), right: `<div class="head-bus">${busSVG(school.settings.buses[0]?.color || "#ffd23f")}</div>` })}<div id="editor"></div></div>`;
      settingsEditor(document.getElementById("editor"), school.settings, {
        mode: "edit",
        onCancel: () => adminPanel(code, pin),
        onDelete(name) {
          openModal(`<h2>Delete ${esc(name)}?</h2>
            <p>This permanently deletes the school, its buses, settings and PIN. Classroom screens will stop working. <b>This can't be undone.</b></p>
            <label>Type the school name to confirm<input id="del-name" autocomplete="off" placeholder="${esc(name)}" /></label>
            <p class="err" id="del-err"></p>
            <div class="row"><button class="btn danger" id="del-go" disabled>Delete forever</button><button class="btn" data-close>Cancel</button></div>`);
          const inp = document.getElementById("del-name"), goBtn = document.getElementById("del-go");
          const norm = (x) => String(x || "").trim().replace(/\s+/g, " ").toLowerCase();
          inp.oninput = () => (goBtn.disabled = norm(inp.value) !== norm(name));
          inp.focus();
          goBtn.onclick = async () => {
            goBtn.disabled = true;
            const r = await api.deleteSchool(code, pin, inp.value);
            if (!r?.ok) { document.getElementById("del-err").textContent = r?.error === "name_mismatch" ? "The name didn't match." : (ERRORS[r?.error] || ERRORS.network); goBtn.disabled = false; return; }
            ["buspin:", "busgroup:", "busvideo:"].forEach((k) => { store.del(k + code); sess.del(k + code); });
            forgetSchool(code);
            api.notify(code);
            closeModal();
            go("/");
            toast("School deleted.");
          };
        },
        async onSubmit(settings, newPin) {
          const r = await api.saveSettings(code, pin, settings, newPin);
          if (!r?.ok) return ERRORS[r?.error] || ERRORS.network;
          let p = pin;
          if (newPin) { p = newPin; sess.set("buspin:" + code, p); if (store.get("buspin:" + code)) store.set("buspin:" + code, p); }
          api.notify(code);
          adminPanel(code, p);
        },
      });
    };
  }

  function draw() {
    const { settings } = school;
    const st = liveState(school.state);
    applyTheme(settings.theme);
    document.title = `Master · ${settings.name}`;
    document.getElementById("a-title").textContent = settings.name;

    // Group bar: call a whole group for every arrived bus
    const bar = document.getElementById("group-bar");
    const arrivedIds = settings.buses.filter((b) => st.buses[b.id]?.arrived && !st.buses[b.id].left).map((b) => b.id);
    bar.innerHTML = `<div class="bar-label">Call a group for <b>every bus that's here</b>:</div>` + settings.groups.map((g) => {
      const waiting = arrivedIds.filter((id) => !st.buses[id].called[g.id]).length;
      return `<button class="btn group-call ${waiting ? "" : "done"}" data-callgroup="${g.id}" ${waiting ? "" : "disabled"}>
        📣 ${esc(g.name)} <span class="count">${waiting ? `${waiting} bus${waiting > 1 ? "es" : ""}` : arrivedIds.length ? "✓ all called" : "—"}</span></button>`;
    }).join("");
    bar.querySelectorAll("[data-callgroup]").forEach((b) => (b.onclick = () => act({ type: "callGroup", group: b.dataset.callgroup })));

    // Bus cards
    const grid = document.getElementById("bus-grid");
    grid.innerHTML = settings.buses.map((b) => {
      const s = st.buses[b.id];
      const arrived = !!s?.arrived;
      const left = !!s?.left;
      const nextG = settings.groups.find((g) => !s?.called?.[g.id]);
      const allCalled = arrived && !nextG;
      const sub = left ? `Left campus at ${fmtTime(s.left)}` : arrived ? `Here since ${fmtTime(s.arrived)}` : "Not here yet";
      return `<div class="card bus-card ${arrived ? "arrived" : ""} ${left ? "gone" : ""}">
        <div class="bus-head">${busSVG(b.color, left || !arrived ? "faded" : "parked")}<div><div class="bus-name">${esc(b.name)}</div><div class="muted small">${sub}</div></div></div>
        ${left
          ? `<button class="btn arrive-btn left-btn on" data-unleave="${b.id}">✓ Left campus</button>`
          : `<div class="row nowrap two-btn">
              <button class="btn arrive-btn ${arrived ? "on" : ""}" data-arrive="${b.id}">${arrived ? "✓ Arrived" : "Mark arrived"}</button>
              ${arrived ? `<button class="btn leave-btn ${allCalled ? "ready" : ""}" data-leave="${b.id}" title="Mark this bus as gone">Bus left</button>` : ""}
            </div>`}
        <div class="cells">${settings.groups.map((g) => {
          const t = s?.called?.[g.id];
          return `<button class="cell ${t ? "called" : ""} ${!t && arrived && nextG?.id === g.id ? "next" : ""}" data-bus="${b.id}" data-group="${g.id}">
            <span>${esc(g.name)}</span><small>${t ? "✓ " + fmtTime(t) : "Call"}</small></button>`;
        }).join("")}</div>
      </div>`;
    }).join("");
    grid.querySelectorAll("[data-arrive]").forEach((el) => (el.onclick = () => {
      const id = el.dataset.arrive;
      if (st.buses[id]?.arrived) {
        const name = settings.buses.find((b) => b.id === id)?.name;
        confirmModal(`Undo arrival for the ${esc(name)} bus? This also clears its calls.`, "Undo arrival", () => act({ type: "unarrive", bus: id }));
      } else act({ type: "arrive", bus: id });
    }));
    grid.querySelectorAll("[data-leave]").forEach((el) => (el.onclick = () => act({ type: "leave", bus: el.dataset.leave })));
    grid.querySelectorAll("[data-unleave]").forEach((el) => (el.onclick = () => {
      const name = settings.buses.find((b) => b.id === el.dataset.unleave)?.name;
      confirmModal(`Mark the ${esc(name)} bus as still here?`, "Yes, it's still here", () => act({ type: "unleave", bus: el.dataset.unleave }));
    }));
    grid.querySelectorAll("[data-bus]").forEach((el) => (el.onclick = () => {
      const bus = el.dataset.bus, group = el.dataset.group;
      if (st.buses[bus]?.called?.[group]) {
        const bn = settings.buses.find((b) => b.id === bus)?.name, gn = settings.groups.find((g) => g.id === group)?.name;
        openModal(`<h2>${esc(bn)} · ${esc(gn)}</h2><p>Already called. What would you like to do?</p>
          <div class="row"><button class="btn primary" id="m-again">🔔 Call again</button><button class="btn danger" id="m-undo">Undo call</button><button class="btn" data-close>Cancel</button></div>`);
        document.getElementById("m-again").onclick = () => { closeModal(); act({ type: "call", bus, group }); };
        document.getElementById("m-undo").onclick = () => { closeModal(); act({ type: "uncall", bus, group }); };
      } else act({ type: "call", bus, group });
    }));

    // Log
    const busName = (id) => settings.buses.find((b) => b.id === id)?.name ?? "?";
    const grpName = (id) => settings.groups.find((g) => g.id === id)?.name ?? "?";
    const lines = st.log.slice().reverse().map((e) => {
      const what = { arrive: `🚌 ${esc(busName(e.bus))} arrived`, unarrive: `↩︎ ${esc(busName(e.bus))} arrival undone`, call: `📣 ${esc(busName(e.bus))} — called ${esc(grpName(e.group))}`, uncall: `↩︎ ${esc(busName(e.bus))} — ${esc(grpName(e.group))} call undone`, leave: `👋 ${esc(busName(e.bus))} left campus`, unleave: `↩︎ ${esc(busName(e.bus))} marked as still here` }[e.type];
      return what ? `<li><span class="muted">${fmtTime(e.at)}</span> ${what}</li>` : "";
    }).join("");
    document.getElementById("log").innerHTML = lines || `<li class="muted">Nothing yet today.</li>`;
  }
}

/* ============================ WAITING VIDEO ============================ */
// Teachers can paste a YouTube or Google Drive link. YouTube pauses and
// resumes automatically; Drive has no pause control, so it is unloaded
// during a call and reloaded afterwards (it starts over).
function parseVideo(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\./, "");
  const toSec = (t) => {
    if (!t) return 0;
    if (/^\d+$/.test(t)) return +t;
    const m = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/.exec(t);
    return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
  };
  const start = toSec(u.searchParams.get("t") || u.searchParams.get("start"));
  const list = u.searchParams.get("list") || "";
  let id = "";
  if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
  else if (host.endsWith("youtube.com") || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v") || "";
    else { const m = /^\/(?:embed|shorts|live|v)\/([\w-]{6,})/.exec(u.pathname); if (m) id = m[1]; }
    if (!id && !list) return null;
    return { kind: "yt", id, list, start };
  } else if (host === "drive.google.com") {
    const m = /\/file\/d\/([\w-]+)/.exec(u.pathname);
    const did = m ? m[1] : u.searchParams.get("id");
    return did ? { kind: "drive", id: did } : null;
  } else return null;
  return /^[\w-]{6,}$/.test(id) ? { kind: "yt", id, list, start } : null;
}
let ytLoading = null;
function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (ytLoading) return ytLoading;
  ytLoading = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev && prev(); resolve(window.YT); };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    tag.onerror = () => { ytLoading = null; reject(new Error("yt")); };
    document.head.appendChild(tag);
    setTimeout(() => { if (!(window.YT && window.YT.Player)) { ytLoading = null; reject(new Error("timeout")); } }, 15000);
  });
  return ytLoading;
}

/* ========================== CLASSROOM SCREEN =========================== */
function renderDisplay(code) {
  const groupKey = "busgroup:" + code;
  let school = null;
  let group = store.get(groupKey);
  let started = false;
  let lastSeq = null, lastDay = null;
  const queue = [];
  let showing = false;
  let wakeLock = null;
  const videoKey = "busvideo:" + code;
  let videoUrl = store.get(videoKey) || "";
  let player = null;        // YouTube player
  let videoPaused = false;  // we paused it for a call
  let driveSrc = "";        // Drive iframe src while unloaded

  const feed = liveSchool(code, (s, err) => {
    const dot = document.getElementById("live-dot");
    if (err) { dot && (dot.className = "live-dot offline"); return; }
    if (!s) { applyTheme(THEMES.STEMstarters); $app.innerHTML = `<div class="center-card card"><h2>${ERRORS.not_found}</h2><p><a href="/">Home</a></p></div>`; return; }
    if (!school) rememberSchool(code, s.settings.name);
    school = s;
    applyTheme(s.settings.theme);
    document.title = s.settings.name;
    if (group && group !== "all" && !s.settings.groups.some((g) => g.id === group)) group = null;
    if (!started) { if (!document.getElementById("start-screen")) startScreen(); return; }
    detectNewCalls();
    draw();
    const d = document.getElementById("live-dot"); d && (d.className = "live-dot live");
  });
  const tick = setInterval(() => { if (started && school) draw(); }, 15000);
  cleanup = () => { feed.stop(); clearInterval(tick); destroyPlayer(); try { wakeLock?.release(); } catch {} };

  function startScreen() {
    const { settings } = school;
    const lang = settings.lang;
    $app.innerHTML = `${demoBanner()}
      <div class="center-card card" id="start-screen">
        <div class="hero-bus">${busSVG(settings.buses[0]?.color || "#ffd23f", "drive-in")}</div>
        <h1>${esc(settings.name)}</h1>
        <h2>${tr("pickGroup", lang)}</h2>
        <div class="group-pick">
          ${settings.groups.map((g) => `<button class="btn big ${group === g.id ? "primary" : ""}" data-pick="${g.id}">${esc(g.name)}</button>`).join("")}
          <button class="btn ${group === "all" ? "primary" : ""}" data-pick="all">${tr("allGroups", lang)}</button>
        </div>
        <p class="muted small">🔔 ${tr("tapToStart", lang)}</p>
      </div>`;
    $app.querySelectorAll("[data-pick]").forEach((b) => (b.onclick = () => {
      group = b.dataset.pick;
      store.set(groupKey, group);
      unlockAudio();
      requestWake();
      started = true;
      const st = liveState(school.state);
      lastSeq = st.seq; lastDay = st.day;
      shell();
      draw();
    }));
  }

  async function requestWake() {
    try { if ("wakeLock" in navigator) { wakeLock = await navigator.wakeLock.request("screen"); } } catch {}
  }
  document.addEventListener("visibilitychange", () => { if (started && !document.hidden) requestWake(); });

  function shell() {
    $app.innerHTML = `${demoBanner()}
      <div class="display">
        ${headBlock({ compact: true, pill: `<span id="live-dot" class="live-dot live"></span> ${wordmark()}`, title: "", titleId: "d-title", right: `<button class="chip" id="d-group"></button>` })}
        <div class="message" id="d-msg"></div>
        <div class="d-main">
          <section id="video-wrap"></section>
          <div class="d-side">
            <div class="road" id="road"><div class="road-line"></div><div class="road-zone here" id="road-here"></div><div class="road-zone gone" id="road-gone"></div></div>
            <div class="d-grid" id="d-grid"></div>
          </div>
        </div>
      </div>
      <div class="popup-layer" id="popup-layer"></div>`;
    document.getElementById("d-group").onclick = () => { destroyPlayer(); started = false; startScreen(); };
    drawVideo();
  }

  function destroyPlayer() {
    try { player && player.destroy && player.destroy(); } catch {}
    player = null; videoPaused = false; driveSrc = "";
  }

  function drawVideo() {
    const wrap = document.getElementById("video-wrap");
    if (!wrap) return;
    destroyPlayer();
    const v = videoUrl ? parseVideo(videoUrl) : null;
    document.querySelector(".display")?.classList.toggle("has-video", !!v);
    // With a video, the street moves under the video; without one, back above the bus cards.
    const road = document.getElementById("road");
    const side = document.querySelector(".d-side");
    if (road && side) { if (v) wrap.after(road); else side.prepend(road); }
    if (!v) {
      wrap.innerHTML = `<div class="card step s2 video-card">
        <h2><span class="v-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="30" height="30"><rect x="3" y="5" width="18" height="14" rx="4" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M10 9.2v5.6l4.8-2.8z" fill="currentColor"/></svg></span> Watch while you wait</h2>
        <p class="muted">Paste a YouTube or Google Drive video link. It pauses by itself when your group is called.</p>
        <form id="v-form" class="v-form">
          <label class="sr" for="v-url">Video link</label>
          <input id="v-url" placeholder="https://www.youtube.com/watch?v=…" autocomplete="off" />
          <button class="btn primary" type="submit">Play video</button>
        </form>
        <p class="err" id="v-err"></p>
      </div>`;
      document.getElementById("v-form").onsubmit = (e) => {
        e.preventDefault();
        const val = document.getElementById("v-url").value.trim();
        if (!parseVideo(val)) { document.getElementById("v-err").textContent = "That doesn't look like a YouTube or Google Drive video link."; return; }
        videoUrl = val; store.set(videoKey, val); unlockAudio(); drawVideo();
      };
      return;
    }
    wrap.innerHTML = `<div class="video-card playing">
      <div class="video-frame" id="video-frame"><div id="yt-player"></div></div>
      <div class="row center video-tools">
        <span class="muted small">${v.kind === "yt" ? "Pauses automatically when your group is called." : "Google Drive videos can't be paused by the app, so this one restarts after a call. YouTube links pause and resume."}</span>
        <button class="btn small" type="button" id="v-change">Change video</button>
        <button class="btn small" type="button" id="v-remove">Remove video</button>
      </div>
    </div>`;
    document.getElementById("v-change").onclick = () => { videoUrl = ""; drawVideo(); setTimeout(() => document.getElementById("v-url")?.focus(), 50); };
    document.getElementById("v-remove").onclick = () => { videoUrl = ""; store.del(videoKey); drawVideo(); };
    const frame = document.getElementById("video-frame");
    if (v.kind === "drive") {
      frame.innerHTML = `<iframe id="drive-frame" src="https://drive.google.com/file/d/${encodeURIComponent(v.id)}/preview" allow="autoplay; fullscreen" allowfullscreen title="Video"></iframe>`;
      return;
    }
    loadYouTubeApi().then((YT) => {
      if (!document.getElementById("yt-player")) return;
      const vars = { rel: 0, playsinline: 1, modestbranding: 1, autoplay: 1 };
      if (v.start) vars.start = v.start;
      if (v.list) { vars.list = v.list; vars.listType = "playlist"; }
      player = new YT.Player("yt-player", {
        width: "100%", height: "100%", host: "https://www.youtube-nocookie.com",
        videoId: v.id || undefined, playerVars: vars,
      });
    }).catch(() => {
      // API blocked? Fall back to a plain embed (no auto-pause).
      const params = new URLSearchParams({ rel: "0", playsinline: "1", autoplay: "1" });
      if (v.start) params.set("start", v.start);
      if (v.list) params.set("list", v.list);
      frame.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(v.id || "videoseries")}?${params}" allow="autoplay; fullscreen; encrypted-media" allowfullscreen title="Video"></iframe>`;
    });
  }

  function pauseVideo() {
    if (videoPaused) return;
    try {
      if (player && player.getPlayerState) {
        const st = player.getPlayerState();
        if (st === 1 || st === 3) { player.pauseVideo(); videoPaused = true; }
        return;
      }
    } catch {}
    const df = document.getElementById("drive-frame");
    if (df && df.src && df.src !== "about:blank") { driveSrc = df.src; df.src = "about:blank"; videoPaused = true; }
  }
  function resumeVideo() {
    if (!videoPaused) return;
    videoPaused = false;
    try { if (player && player.playVideo) { player.playVideo(); return; } } catch {}
    const df = document.getElementById("drive-frame");
    if (df && driveSrc) { df.src = driveSrc; driveSrc = ""; }
  }

  function detectNewCalls() {
    const st = liveState(school.state);
    if (lastDay !== st.day) { lastDay = st.day; lastSeq = 0; }
    const fresh = st.log.filter((e) => e.seq > (lastSeq ?? 0) && e.type === "call" && (group === "all" || e.group === group) && Date.now() - e.at < GO_NOW_MS);
    lastSeq = Math.max(lastSeq ?? 0, st.seq || 0);
    fresh.forEach((e) => queue.push(e));
    pump();
  }

  function pump() {
    if (showing || !queue.length) return;
    const e = queue.shift();
    const { settings } = school;
    const bus = settings.buses.find((b) => b.id === e.bus);
    const grp = settings.groups.find((g) => g.id === e.group);
    if (!bus || !grp) return pump();
    showing = true;
    const lang = settings.lang;
    const layer = document.getElementById("popup-layer");
    if (!layer) { showing = false; return; }
    pauseVideo();
    layer.style.setProperty("--bus", bus.color);
    layer.innerHTML = `<div class="road-strip" aria-hidden="true">${[0, 1, 2].map((i) => `<span style="--d:${i}">${busSVG(bus.color)}</span>`).join("")}</div>
    <div class="popup" style="--bus:${esc(bus.color)}">
      <div class="confetti">${Array.from({ length: 24 }, (_, i) => `<i style="--i:${i};--c:${i % 3 ? "var(--accent)" : esc(bus.color)}"></i>`).join("")}</div>
      <div class="popup-bus">${busSVG(bus.color, "drive-in bounce")}</div>
      <div class="popup-title">${lang === "es" ? `Autobús ${esc(bus.name)}` : `${esc(bus.name)} bus`}</div>
      <div class="popup-group">${esc(grp.name)}</div>
      <div class="popup-sub">${tr("sendRiders", lang)}</div>
      <div class="muted small">Tap to close</div>
    </div>`;
    playSound(soundOf(settings));
    const close = () => {
      layer.innerHTML = ""; showing = false; clearTimeout(timer);
      setTimeout(() => { if (!queue.length) resumeVideo(); pump(); }, 300);
    };
    const timer = setTimeout(close, 15000);
    layer.onclick = close;
  }

  function draw() {
    if (!document.getElementById("d-grid")) return;
    const { settings } = school;
    const st = liveState(school.state);
    const lang = settings.lang;
    const now = Date.now();
    document.getElementById("d-title").textContent = settings.name;
    const gName = group === "all" ? (lang === "es" ? "Todos" : "All groups") : settings.groups.find((g) => g.id === group)?.name;
    document.getElementById("d-group").innerHTML = `👥 ${esc(gName || "?")} <span class="muted">· change</span>`;
    document.getElementById("d-msg").innerHTML = settings.message ? `💬 ${esc(settings.message)}` : "";
    document.getElementById("d-msg").style.display = settings.message ? "" : "none";

    // Street: a line of buses facing right. New arrivals pull in behind (to the left of)
    // the buses already here; a bus that leaves drives to the right end and lines up
    // behind (to the left of) buses that already left. Nobody swaps places.
    const road = document.getElementById("road");
    const hereZone = document.getElementById("road-here");
    const goneZone = document.getElementById("road-gone");
    const beforeX = new Map([...road.querySelectorAll("[data-road]")].map((n) => [n.dataset.road, n.getBoundingClientRect().left]));
    const info = (b) => st.buses[b.id] || {};
    const hereList = settings.buses.filter((b) => info(b).arrived && !info(b).left).sort((x, y) => info(y).arrived - info(x).arrived);
    const goneList = settings.buses.filter((b) => info(b).left).sort((x, y) => info(y).left - info(x).left);
    const keep = new Set([...hereList, ...goneList].map((b) => b.id));
    road.querySelectorAll("[data-road]").forEach((n) => { if (!keep.has(n.dataset.road)) n.remove(); });
    const busEl = (b) => {
      let el = road.querySelector(`[data-road="${b.id}"]`);
      if (!el) {
        el = document.createElement("div");
        el.className = "road-bus";
        el.dataset.road = b.id;
        el.innerHTML = busSVG(b.color, "drive-in") + `<span>${esc(b.name)}</span>`;
      }
      return el;
    };
    hereList.forEach((b) => { const el = busEl(b); el.classList.remove("parked-gone"); hereZone.appendChild(el); });
    goneList.forEach((b) => { const el = busEl(b); el.classList.add("parked-gone"); goneZone.appendChild(el); });
    // Slide anything that moved from where it was to where it is now
    road.querySelectorAll("[data-road]").forEach((el) => {
      const was = beforeX.get(el.dataset.road);
      if (was === undefined) return;
      const dx = was - el.getBoundingClientRect().left;
      if (Math.abs(dx) > 1) {
        el.querySelector(".bus-svg")?.classList.remove("drive-in");
        el.animate([{ transform: `translateX(${dx}px)` }, { transform: "translateX(0)" }], { duration: Math.min(2200, 500 + Math.abs(dx) * 1.6), easing: "ease-in-out" });
      }
    });
    road.classList.toggle("empty", !road.querySelector("[data-road]"));
    road.dataset.empty = T.noBusesYet[lang === "es" ? 1 : 0];

    // Cards
    const groupsToShow = group === "all" ? settings.groups : settings.groups.filter((g) => g.id === group);
    const order = (b) => (st.buses[b.id]?.left ? 1 : 0); // buses that left go to the bottom
    const sorted = settings.buses.slice().sort((x, y) => order(x) - order(y));
    document.getElementById("d-grid").innerHTML = sorted.map((b) => {
      const s = st.buses[b.id];
      let status = "away", label = tr("onTheWay", lang), sub = "";
      if (s?.arrived) { status = "here"; label = tr("here", lang); }
      const callsHere = groupsToShow.map((g) => s?.called?.[g.id]).filter(Boolean);
      if (group !== "all" && callsHere.length) {
        const t = callsHere[0];
        if (now - t < GO_NOW_MS && !s?.left) { status = "go"; label = tr("goNow", lang); sub = tr("sendRiders", lang); }
        else { status = "sent"; label = `✓ ${tr("sent", lang)}`; sub = `${tr("calledAt", lang)} ${fmtTime(t)}`; }
      }
      if (s?.left) { status = "left"; label = tr("leftCampus", lang); sub = `${tr("leftAt", lang)} ${fmtTime(s.left)}`; }
      const chips = group === "all"
        ? `<div class="chips">${settings.groups.map((g) => { const t = s?.called?.[g.id]; const cls = t ? (now - t < GO_NOW_MS ? "go" : "sent") : ""; return `<span class="g-chip ${cls}">${esc(g.name)}${t ? " ✓" : ""}</span>`; }).join("")}</div>`
        : "";
      return `<div class="d-card ${status}" style="--bus:${esc(b.color)}">
        <div class="d-bus">${busSVG(b.color, status === "go" ? "bounce" : status === "away" ? "soft" : status === "left" ? "gone" : "")}</div>
        <div class="d-name">${esc(b.name)}</div>
        <div class="d-status ${status === "go" ? "" : "pill"}">${status === "away" ? "🕒 " : status === "here" ? "📍 " : ""}${label}</div>
        ${sub ? `<div class="d-sub">${sub}</div>` : ""}
        ${chips}
      </div>`;
    }).join("");
  }
}

/* ============================ OWNER STATS ============================== */
function daySummary(state) {
  if (!state?.day || !state.buses) return null;
  const bs = Object.values(state.buses);
  const arrived = bs.filter((b) => b.arrived).length;
  const calls = bs.reduce((a, b) => a + Object.keys(b.called || {}).length, 0);
  const left = bs.filter((b) => b.left).length;
  return arrived || calls ? { arrived, calls, left } : null;
}
const fmtNum = (n) => Number(n || 0).toLocaleString();
const fmtDay = (d, opts = { month: "short", day: "numeric" }) => d ? new Date(d + "T12:00:00").toLocaleDateString([], opts) : "—";

function renderOwner() {
  applyTheme(THEMES.STEMstarters);
  document.title = "Owner stats · Dismissal Magic";
  const key = sess.get("busownerkey");
  if (!key) {
    $app.innerHTML = `${demoBanner()}
      <div class="center-card card">
        <div class="hero-bus small">${busSVG("#ffd23f")}</div>
        <h1>Owner stats</h1>
        <p class="muted">Private to the Dismissal Magic owner.</p>
        <form id="owner-form" class="stack">
          <label class="sr" for="owner-key">Owner passphrase</label>
          <input id="owner-key" type="password" autocomplete="current-password" placeholder="Owner passphrase" autofocus />
          <button class="btn primary big" type="submit">Open stats</button>
          <p class="err" id="owner-err"></p>
        </form>
      </div>`;
    document.getElementById("owner-form").onsubmit = async (e) => {
      e.preventDefault();
      const k = document.getElementById("owner-key").value;
      const r = await api.ownerStats(k, 30);
      if (!r?.ok) {
        document.getElementById("owner-err").textContent = { bad_key: "That passphrase didn't match.", locked: ERRORS.locked, no_owner_key: "No owner passphrase is set yet. Run the stats update in Supabase first." }[r?.error] || ERRORS.network;
        return;
      }
      sess.set("busownerkey", k);
      ownerDashboard(k, r);
    };
    return;
  }
  ownerDashboard(key, null);
}

async function ownerDashboard(key, first) {
  let days = 30;
  const out = () => { sess.del("busownerkey"); renderOwner(); };
  $app.innerHTML = `${demoBanner()}<div class="page owner">
    ${headBlock({ pill: wordmark(), title: "Owner stats", sub: "Magic Dismissals across every school.", right: `<div class="row"><button class="btn small light" id="o-refresh">Refresh</button><button class="btn small light" id="o-out">Lock</button></div>` })}
    <div id="o-body"><p class="muted">Loading…</p></div></div>`;
  document.getElementById("o-out").onclick = out;
  document.getElementById("o-refresh").onclick = () => load();
  async function load() {
    const r = first || await api.ownerStats(key, days);
    first = null;
    if (!r?.ok) { if (r?.error === "bad_key" || r?.error === "locked") return out(); document.getElementById("o-body").innerHTML = `<p class="err">${ERRORS.network}</p>`; return; }
    draw(r);
  }
  function draw(r) {
    const t = r.totals || {};
    const tile = (label, value, sub, cls = "") => `<div class="card stat ${cls}"><div class="stat-label">${label}</div><div class="stat-value">${value}</div>${sub ? `<div class="stat-sub">${sub}</div>` : ""}</div>`;
    document.getElementById("o-body").innerHTML = `
      <section class="stat-grid">
        <div class="card stat hero s1 magic-box">
          <div class="magic-line"><span class="stat-value">${fmtNum(t.dismissals)}</span> <span class="magic-words">Magic Dismissals ✨</span></div>
          <div class="stat-sub">${t.first_day ? `Counting since ${fmtDay(t.first_day, { month: "long", day: "numeric", year: "numeric" })}` : "Starts counting with the next dismissal"}</div>
        </div>
        ${tile("This week", fmtNum(t.dismissals_7d), "Last 7 days", "s2")}
        ${tile("Schools", fmtNum(t.schools), `${fmtNum(t.active_schools_7d)} active this week · ${fmtNum(t.new_schools_7d)} new`, "s3")}
        ${tile("Group calls", fmtNum(t.group_calls), `${fmtNum(t.buses_arrived)} bus arrivals`, "s4")}
      </section>
      <section class="card chart-card">
        <div class="row spread">
          <div><h2>Magic Dismissals per day</h2><p class="muted small">One school's dismissal day = 1</p></div>
          <div class="seg" role="group" aria-label="Time range">
            ${[30, 90, 365].map((d) => `<button type="button" class="seg-btn ${d === days ? "on" : ""}" data-days="${d}">${d === 365 ? "1 year" : d + " days"}</button>`).join("")}
          </div>
        </div>
        <div class="chart-wrap" id="o-chart"></div>
        <details class="table-view"><summary>Show as a table</summary>
          <table class="data"><thead><tr><th>Day</th><th>Dismissals</th><th>Group calls</th></tr></thead><tbody>
          ${r.daily.slice().reverse().map((d) => `<tr><td>${fmtDay(d.day, { weekday: "short", month: "short", day: "numeric" })}</td><td>${fmtNum(d.dismissals)}</td><td>${fmtNum(d.calls)}</td></tr>`).join("")}
          </tbody></table></details>
      </section>
      <section class="card">
        <h2>Schools</h2>
        <div class="table-scroll"><table class="data"><thead><tr><th>School</th><th>Code</th><th>Buses</th><th>Dismissals</th><th>Group calls</th><th>Last used</th></tr></thead><tbody>
        ${(r.schools || []).map((s) => `<tr><td><b>${esc(s.name || "—")}</b></td><td class="mono">${esc(s.code)}</td><td>${fmtNum(s.buses)}</td><td>${fmtNum(s.dismissals)}</td><td>${fmtNum(s.group_calls)}</td><td>${s.last_day ? fmtDay(s.last_day) : "Not yet"}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">No schools yet.</td></tr>`}
        </tbody></table></div>
      </section>`;
    drawBars(document.getElementById("o-chart"), r.daily);
    document.querySelectorAll("[data-days]").forEach((b) => (b.onclick = () => { days = +b.dataset.days; load(); }));
  }
  load();
}

// Single-series column chart with hover tooltips (no legend needed: one series).
function drawBars(el, data) {
  const W = Math.max(320, el.clientWidth || 800), H = 260, padL = 44, padR = 12, padT = 16, padB = 34;
  const max = Math.max(1, ...data.map((d) => d.dismissals));
  const step = max <= 5 ? 1 : max <= 10 ? 2 : Math.ceil(max / 5 / 5) * 5;
  const top = Math.ceil(max / step) * step;
  const iw = W - padL - padR, ih = H - padT - padB;
  const band = iw / data.length, bw = Math.max(2, Math.min(24, band - 2));
  const y = (v) => padT + ih - (v / top) * ih;
  const ticks = []; for (let v = 0; v <= top; v += step) ticks.push(v);
  const every = Math.ceil(data.length / 8);
  const bars = data.map((d, i) => {
    const x = padL + i * band + (band - bw) / 2, h = (d.dismissals / top) * ih, r = Math.min(4, bw / 2, h);
    const path = h > 0 ? `M${x},${padT + ih} V${padT + ih - h + r} Q${x},${padT + ih - h} ${x + r},${padT + ih - h} H${x + bw - r} Q${x + bw},${padT + ih - h} ${x + bw},${padT + ih - h + r} V${padT + ih} Z` : "";
    return `<g class="bar-g" data-i="${i}"><rect x="${padL + i * band}" y="${padT}" width="${band}" height="${ih}" fill="transparent"/>${path ? `<path d="${path}" fill="#9246DD"/>` : ""}</g>`;
  }).join("");
  const showX = (i) => i % every === 0 ? (data.length - 1 - i >= every / 2 || i === data.length - 1) : i === data.length - 1;
  const xl = data.map((d, i) => showX(i) ? `<text x="${padL + i * band + band / 2}" y="${H - 10}" text-anchor="middle">${esc(fmtDay(d.day))}</text>` : "").join("");
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Magic Dismissals per day, last ${data.length} days">
    ${ticks.map((v) => `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${fmtNum(v)}</text>`).join("")}
    ${bars}${xl}</svg><div class="tip" hidden></div>`;
  const tip = el.querySelector(".tip");
  el.querySelectorAll(".bar-g").forEach((g) => {
    g.onmouseenter = g.onmousemove = (e) => {
      const d = data[+g.dataset.i];
      tip.innerHTML = `<b>${esc(fmtDay(d.day, { weekday: "short", month: "short", day: "numeric" }))}</b><br>${fmtNum(d.dismissals)} Magic Dismissal${d.dismissals === 1 ? "" : "s"}<br><span>${fmtNum(d.calls)} group calls</span>`;
      tip.hidden = false;
      const box = el.getBoundingClientRect();
      tip.style.left = Math.min(box.width - 170, Math.max(0, e.clientX - box.left + 12)) + "px";
      tip.style.top = Math.max(0, e.clientY - box.top - 70) + "px";
    };
    g.onmouseleave = () => (tip.hidden = true);
  });
}

/* ================================ MODAL ================================ */
function openModal(html) {
  $modal.innerHTML = `<div class="modal-back"><div class="modal card">${html}</div></div>`;
  $modal.querySelector(".modal-back").onclick = (e) => { if (e.target.classList.contains("modal-back")) closeModal(); };
  $modal.querySelectorAll("[data-close]").forEach((b) => (b.onclick = closeModal));
}
function closeModal() { $modal.innerHTML = ""; }
function confirmModal(text, okLabel, onOk) {
  openModal(`<p class="lead">${text}</p><div class="row"><button class="btn danger" id="m-ok">${esc(okLabel)}</button><button class="btn" data-close>Cancel</button></div>`);
  document.getElementById("m-ok").onclick = () => { closeModal(); onOk(); };
}
function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

boot();
