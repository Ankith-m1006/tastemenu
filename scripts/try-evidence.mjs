import { gatherEvidence } from "../src/evidence.mjs";
import { closeQloo } from "../src/qloo.mjs";
import { writeFile } from "node:fs/promises";
try {
  const ev = await gatherEvidence({ area: "Jayanagar, Bengaluru", cuisine: "Udupi" });
  await writeFile(".cache/sample-evidence.json", JSON.stringify(ev, null, 1));
  console.log("status:", ev.status, "| cuisine tag:", ev.cuisine?.tag?.name, ev.cuisine?.tag?.id);
  for (const t of ev.trace) console.log(" trace:", t.label, "->", t.status, t.summary ? "| " + String(t.summary).slice(0, 90) : "");
  const show = (k, xs) => console.log(k.padEnd(9), (xs || []).slice(0, 6).map((x) => `${x.name}${x.affinity ? " " + x.affinity : ""}`).join(" | "));
  show("peers", ev.peers); show("artists", ev.audience?.artists); show("movies", ev.audience?.movies); show("tv", ev.audience?.tvShows); show("brands", ev.audience?.brands); show("partners", ev.partners);
  console.log("knownFor ", (ev.knownFor || []).slice(0, 12).map((t) => t.name).join(" | "));
  console.log("demo     ", JSON.stringify(ev.audience?.demographics)?.slice(0, 300));
} finally { await closeQloo(); }
