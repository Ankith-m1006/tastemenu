// Runs TasteMenu end to end for a set of restaurant personas and writes a results table.
// Usage: node scripts/eval.mjs <baseUrl> [out.json]
import { writeFileSync } from "node:fs";

const PERSONAS = [
  "Pure-veg Udupi restaurant in Jayanagar, Bengaluru. Office crowd at lunch, families on weekends.",
  "Biryani cloud kitchen in Koramangala, Bengaluru. Delivery only, lots of late-night orders.",
  "Irani cafe in Colaba, Mumbai. Bun maska and chai, tourists and college students.",
  "North Indian dhaba-style restaurant in Connaught Place, New Delhi. Office lunches and evening groups.",
  "Chettinad restaurant in T. Nagar, Chennai. Families and shoppers.",
  "Hyderabadi biryani restaurant in Banjara Hills, Hyderabad. Families on weekends, young professionals.",
  "Bengali home-style restaurant on Park Street, Kolkata. Older regulars and tourists.",
  "Neighborhood Italian trattoria in the West Village, New York. Date nights and weekend brunch.",
  "Taqueria in Silver Lake, Los Angeles. Young creatives and late-night crowd.",
  "Modern Indian restaurant in Shoreditch, London. After-work groups and weekend brunch.",
];

const base = process.argv[2] ?? "http://localhost:4200";
const out = process.argv[3] ?? "eval-results.json";

async function runOne(message) {
  const t0 = Date.now();
  const res = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message }) });
  const r = { message, ok: res.ok, events: {}, firstPlanSecs: null };
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /^event: (.+)$/m.exec(chunk)?.[1], data = /^data: (.+)$/m.exec(chunk)?.[1];
      if (!ev || !data) continue;
      r.events[ev] = JSON.parse(data);
      if (ev === "plan") r.firstPlanSecs = Math.round((Date.now() - t0) / 1000);
    }
  }
  r.totalSecs = Math.round((Date.now() - t0) / 1000);
  return r;
}

function summarise(r) {
  const ev = r.events.evidence, plan = r.events.plan, kit = r.events.kit, trace = r.events.trace?.trace ?? [];
  const evidence = (plan?.cards ?? []).flatMap((c) => c.evidence ?? []);
  return {
    restaurant: r.message.split(".")[0],
    city: ev?.city ?? null,
    cuisine_tag: ev?.cuisine_tag?.name ?? null,
    qloo_calls: trace.length,
    qloo_ok: trace.filter((t) => ["ok", "partial", "degraded"].includes(t.status)).length,
    similar_places: ev?.similar_places?.length ?? 0,
    films: ev?.audience?.films?.length ?? 0,
    artists: ev?.audience?.music_artists?.length ?? 0,
    brands: ev?.audience?.brands?.length ?? 0,
    plan_cards: plan?.cards?.length ?? 0,
    evidence_verified: evidence.filter((e) => e.verified).length,
    evidence_dropped: evidence.filter((e) => e.verified === false).length,
    occasion: (plan?.cards ?? []).map((c) => c.occasion).find(Boolean) ?? null,
    coming_up: (ev?.coming_up ?? []).map((o) => o.name),
    kit_language: kit?.local_language ?? null,
    kit_items: kit?.items?.length ?? 0,
    posters: (kit?.items ?? []).filter((i) => i.poster_title).length,
    baseline: Boolean(r.events.generic),
    first_plan_secs: r.firstPlanSecs,
    total_secs: r.totalSecs,
    error: r.events.error?.message ?? (plan ? null : r.events.reply?.text?.slice(0, 160) ?? "no plan"),
    headline: plan?.headline ?? null,
    cards: (plan?.cards ?? []).map((c) => `${c.kind}: ${c.title}`),
  };
}

const rows = [];
for (const p of PERSONAS) {
  try {
    const s = summarise(await runOne(p));
    rows.push(s);
    console.log(`${s.plan_cards === 4 ? "PASS" : "FAIL"} ${s.restaurant} | ${s.city} | plan ${s.first_plan_secs}s | verified ${s.evidence_verified} dropped ${s.evidence_dropped} | ${s.kit_language} | ${s.occasion ?? "-"}${s.error ? ` | ${s.error}` : ""}`);
  } catch (e) {
    rows.push({ restaurant: p.split(".")[0], error: e.message });
    console.log(`FAIL ${p.split(".")[0]} | ${e.message}`);
  }
  writeFileSync(out, JSON.stringify(rows, null, 1));
}
