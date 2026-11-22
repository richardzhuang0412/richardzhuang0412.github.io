// Size advisor: compares garment measurements (from a pasted size chart) with
// the user's body measurements and recommends a size.

const FIELDS = {
  chest: /胸围|胸寬|胸宽|bust|chest/i,
  waist: /腰围|腰寬|腰宽|waist/i,
  hip: /臀围|臀宽|hip/i,
  shoulder: /肩宽|肩寬|shoulder/i,
  length: /衣长|裤长|裙长|总长|长度|length/i,
  sleeve: /袖长|sleeve/i,
};
const SIZE_TOKEN = /^(XXS|XS|S|M|L|XL|XXL|XXXL|[2-6]XL|均码|F|ONE ?SIZE|\d{2,3}(\/\d{2,3}[A-Z]?)?|[0-9]{1,2})$/i;

/** Parse a pasted size chart (tab / space / comma separated) into [{size, chest, waist, ...}]. */
export function parseSizeChart(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let cols = null;
  const rows = [];
  for (const line of lines) {
    const cells = line.split(/\t|,|，|\||\s{1,}/).filter(Boolean);
    const headerHits = cells.map((c) => Object.keys(FIELDS).find((k) => FIELDS[k].test(c)) || null);
    if (headerHits.filter(Boolean).length >= 1 && !SIZE_TOKEN.test(cells[0])) {
      // First cell is usually "尺码/Size"; measurement columns follow in order.
      cols = headerHits[0] ? headerHits : headerHits.slice(1);
      continue;
    }
    if (!SIZE_TOKEN.test(cells[0]) || !cols) continue;
    const nums = cells.slice(1).map((c) => parseFloat(c.replace(/[^\d.\-–]/g, "").split(/[-–]/)[0]));
    const row = { size: cells[0].toUpperCase() };
    cols.forEach((k, i) => {
      if (k && Number.isFinite(nums[i])) row[k] = nums[i];
    });
    rows.push(row);
  }
  return rows;
}

// Target ease (garment - body, cm) per fit preference.
const EASE = {
  chest: { slim: [2, 6], regular: [6, 12], loose: [12, 22] },
  waist: { slim: [0, 2], regular: [1, 4], loose: [3, 8] },
  hip: { slim: [1, 4], regular: [4, 9], loose: [8, 16] },
  shoulder: { slim: [-1, 1], regular: [-0.5, 2], loose: [1, 6] },
};

function verdict(key, ease, pref) {
  const [lo, hi] = EASE[key][pref];
  if (ease < Math.min(0, lo - 2)) return { level: "tight", text: "偏紧" };
  if (ease < lo) return { level: "snug", text: "略紧" };
  if (ease <= hi) return { level: "ok", text: "合适" };
  if (ease <= hi + 6) return { level: "loose", text: "略宽松" };
  return { level: "big", text: "偏大" };
}

const LABEL = { chest: "胸围", waist: "腰围", hip: "臀围", shoulder: "肩宽" };

/** Evaluate one size row against the body. */
export function evaluate(row, body, pref = "regular") {
  const checks = [];
  for (const k of Object.keys(EASE)) {
    if (row[k] == null || !body[k]) continue;
    // Charts sometimes give half-width ("平铺"): if the value is far below the body, double it.
    let g = row[k];
    if (k !== "shoulder" && g < body[k] * 0.65) g *= 2;
    const ease = g - body[k];
    const [lo, hi] = EASE[k][pref];
    const mid = (lo + hi) / 2;
    checks.push({
      key: k,
      label: LABEL[k],
      garment: g,
      body: body[k],
      ease,
      ...verdict(k, ease, pref),
      penalty: Math.abs(ease - mid) + (ease < lo ? (lo - ease) * 2 : 0),
    });
  }
  const score = checks.length ? checks.reduce((s, c) => s + c.penalty, 0) / checks.length : Infinity;
  return { size: row.size, checks, score };
}

/** Recommend the best size in a chart. */
export function recommend(rows, body, pref = "regular") {
  const evals = rows.map((r) => evaluate(r, body, pref)).filter((e) => e.checks.length);
  evals.sort((a, b) => a.score - b.score);
  return { best: evals[0] || null, all: rows.map((r) => evaluate(r, body, pref)) };
}

/** Rough body estimate from height/weight when the user hasn't measured. */
export function estimateBody({ height, weight, gender }) {
  if (!height || !weight) return {};
  const bmi = weight / Math.pow(height / 100, 2);
  const f = gender === "female";
  const chest = Math.round((f ? 0.5 : 0.52) * height + (bmi - 21) * 2.2);
  const waist = Math.round((f ? 0.4 : 0.44) * height + (bmi - 21) * 2.6);
  const hip = Math.round((f ? 0.53 : 0.51) * height + (bmi - 21) * 2.0);
  const shoulder = Math.round((f ? 0.22 : 0.245) * height + (bmi - 21) * 0.4);
  return { chest, waist, hip, shoulder };
}
