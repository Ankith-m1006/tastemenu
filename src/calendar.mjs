// Upcoming occasions, so the plan is timed to what is coming up for this restaurant's city.
// Dates are fixed holidays or were checked against published calendars (Drik Panchang for
// Hindu festivals). Regional festivals only show for the matching state or country.
const OCCASIONS = [
  { name: "World Food Day", date: "2026-10-16", where: ["ALL"], note: "UN day for food; easy hook for a menu story" },
  { name: "Durga Puja", major: true, date: "2026-10-16", end: "2026-10-20", where: ["WB", "IN"], note: "five days of pandal-hopping; biggest in Bengali communities" },
  { name: "Dussehra / Dasara", major: true, date: "2026-10-20", where: ["IN"], note: "Vijayadashami, a public holiday (Mysuru Dasara in Karnataka); families eat out" },
  { name: "Halloween", date: "2026-10-31", where: ["US"], note: "costume nights and themed specials" },
  { name: "Karnataka Rajyotsava", date: "2026-11-01", where: ["KA"], note: "Karnataka formation day; Kannada pride" },
  { name: "Kerala Piravi", date: "2026-11-01", where: ["KL"], note: "Kerala formation day" },
  { name: "Dhanteras", date: "2026-11-06", where: ["IN"], note: "start of Diwali week; shopping and gifting" },
  { name: "Diwali", major: true, date: "2026-11-08", where: ["IN", "US"], note: "Lakshmi Puja; sweets, gifting and family meals all week (Bhai Dooj 10 Nov)" },
  { name: "Children's Day", date: "2026-11-14", where: ["IN"], note: "family outings; kids' specials" },
  { name: "Thanksgiving", major: true, date: "2026-11-26", where: ["US"], note: "family feasts; takeout sides and pies" },
  { name: "Christmas", major: true, date: "2026-12-25", where: ["ALL"], note: "festive menus, plum cake, family dinners" },
  { name: "New Year's Eve", major: true, date: "2026-12-31", where: ["ALL"], note: "late-night parties and set menus" },
  { name: "Makar Sankranti / Pongal", major: true, date: "2027-01-14", where: ["IN"], note: "harvest festival; ellu-bella in Karnataka, pongal in Tamil Nadu (15 Jan in some regions)" },
  { name: "Republic Day", date: "2027-01-26", where: ["IN"], note: "public holiday; long-weekend outings" },
  { name: "Super Bowl LXI", date: "2027-02-14", where: ["US"], note: "game-day watch parties and platters" },
  { name: "Valentine's Day", major: true, date: "2027-02-14", where: ["ALL"], note: "date nights and set menus for two" },
  { name: "Holi", major: true, date: "2027-03-22", where: ["IN"], note: "festival of colours (Holika Dahan 21 Mar); thandai and sweets" },
];

const STATES = { KA: /karnataka|bengaluru|bangalore|mysuru|mysore|mangaluru|mangalore/i, KL: /kerala|kochi|cochin|thiruvananthapuram|kozhikode/i, WB: /west bengal|kolkata|calcutta/i };

// Works out the country and state from the city and the peer places' addresses.
export function regionOf(evidence) {
  const text = [evidence?.city, ...(evidence?.peers ?? []).slice(0, 5).map((p) => p.address)].filter(Boolean).join(" | ");
  const regions = new Set(["ALL"]);
  if (/india/i.test(text) || Object.values(STATES).some((re) => re.test(text))) regions.add("IN");
  if (/united states|\bUSA\b|, (NY|CA|IL|TX|WA|MA|FL)\b|new york|los angeles|chicago|san francisco/i.test(text)) regions.add("US");
  for (const [code, re] of Object.entries(STATES)) if (re.test(text)) regions.add(code);
  return regions;
}

export function upcomingOccasions(evidence, { days = 45, now = new Date() } = {}) {
  const regions = regionOf(evidence);
  // "Today" in the restaurant's own time zone, so "in 9 days" is right for the owner.
  const tz = regions.has("IN") ? "Asia/Kolkata" : regions.has("US") ? "America/New_York" : "UTC";
  const today = new Date(now.toLocaleDateString("en-CA", { timeZone: tz }));
  return OCCASIONS
    .filter((o) => o.where.some((w) => regions.has(w)))
    .map((o) => {
      const start = new Date(o.date), end = new Date(o.end ?? o.date);
      return { ...o, days_away: Math.round((start - today) / 864e5), ongoing: start <= today && today <= end };
    })
    .filter((o) => o.ongoing || (o.days_away >= 0 && o.days_away <= days))
    // Big festivals first, then the nearest smaller days; shown in date order.
    .sort((a, b) => (b.major ? 1 : 0) - (a.major ? 1 : 0) || a.days_away - b.days_away)
    .slice(0, 5)
    .sort((a, b) => a.days_away - b.days_away)
    .map(({ where, major, ...o }) => o);
}
