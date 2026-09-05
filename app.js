/**
 * FRONTEND — Team Corners 1H
 * Podpięty pod index.html + styles.css.
 * Wymaga wdrożonego workera (worker.js) — ustaw WORKER_URL poniżej.
 */

const WORKER_URL = "https://bold-cloud-1dc1corners-agent.szymonbaj.workers.dev";
const STORAGE_KEY_PREDICTIONS = "corners_predictions_v1";
const STORAGE_KEY_RESULTS = "corners_results_v1";

// ============================================================
// 1. PARSOWANIE WKLEJONEJ LISTY MECZÓW
// ============================================================
function parseMatchList(rawText) {
  // Normalizacja "śmieciowych" znaków, które często wkradają się przy kopiowaniu
  // ze stron internetowych: twarde spacje, niewidoczne znaki, warianty emoji.
  const normalized = rawText
    .replace(/\r\n?/g, "\n")
    .replace(/[\u00A0\u2007\u202F\u200B\u200C\u200D]/g, " ")
    .replace(/\uFE0F/g, "");

  const lines0 = normalized.split("\n").map((l) => l.trim()).filter(Boolean);

  // Sklej linie, w których sama godzina stoi osobno, a nazwy drużyn są w kolejnej linii
  // (częsty efekt kopiowania z niektórych serwisów bukmacherskich).
  const timeOnlyRe = /^\d{1,2}[:.]\d{2}$/;
  const lines = [];
  for (let i = 0; i < lines0.length; i++) {
    if (timeOnlyRe.test(lines0[i]) && i + 1 < lines0.length) {
      lines.push(lines0[i] + " " + lines0[i + 1]);
      i++; // pomiń już wykorzystaną linię z nazwami drużyn
    } else {
      lines.push(lines0[i]);
    }
  }

  const matches = [];
  // Fallback, gdyby użytkownik wkleił same mecze bez nagłówka ligi (🏆 ... (N meczów))
  let currentLeague = "Inne mecze";
  const seenKeys = new Set(); // dedupe: te same drużyny wklejone dwa razy (np. bez godziny w drugiej linii)

  // Nagłówek ligi: dowolny tekst zakończony "(<liczba> mecz...)", emoji 🏆 opcjonalne.
  const leagueRe = /^(?:🏆\s*)?(.+?)\s*\(\s*\d+\s*mecz/iu;
  // Wiersz meczu: godzina (HH:MM lub HH.MM), potem dwie nazwy drużyn rozdzielone
  // albo słowem "vs", albo myślnikiem (-, – en dash, — em dash),
  // z tolerancją na dowolne "śmieci" na końcu (emoji, strzałki, spacje, przecinek) po drugiej drużynie.
  const matchRe = /^(\d{1,2}[:.]\d{2})\s*[-–—]?\s*(.+?)\s+(?:vs\.?|[-–—])\s+(.+?)\s*[^\p{L}\p{N}).\]]*$/iu;

  for (const line of lines) {
    const looksLikeMatch = /^\d{1,2}[:.]\d{2}/.test(line);
    const leagueMatch = !looksLikeMatch && line.match(leagueRe);
    if (leagueMatch) {
      currentLeague = leagueMatch[1].trim();
      continue;
    }
    const m = line.match(matchRe);
    if (m) {
      const [, kickoff, teamA, teamB] = m;
      const dedupeKey = `${currentLeague}__${teamA.trim().toLowerCase()}__${teamB.trim().toLowerCase()}`;
      if (seenKeys.has(dedupeKey)) continue; // odrzuć duplikat tego samego meczu
      seenKeys.add(dedupeKey);

      matches.push({
        id: slugify(`${currentLeague}_${teamA}_${teamB}_${todayISO()}`),
        league: currentLeague,
        kickoff: kickoff.replace(".", ":"),
        date: todayISO(),
        teamA: teamA.trim(),
        teamB: teamB.trim(),
      });
    }
  }
  return matches;
}

function slugify(str) {
  return str
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// ============================================================
// 2. GENEROWANIE PREDYKCJI (wywołanie agenta per mecz)
// ============================================================
async function generatePredictionForMatch(match, side = "HOME") {
  const res = await fetch(WORKER_URL + "/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      match_id: match.id,
      league: match.league,
      kickoff: match.kickoff,
      date: match.date,
      teamA: match.teamA,
      teamB: match.teamB,
      side,
    }),
  });
  const data = await res.json();
  if (data.error) {
    const err = new Error(data.error + (data.detail ? ": " + data.detail : ""));
    err.cost = data.cost || null;
    throw err;
  }
  return data.prediction;
}

async function generateAllPredictions(matches, { concurrency = 2, onProgress } = {}) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < matches.length) {
      const i = idx++;
      const match = matches[i];
      try {
        const prediction = await generatePredictionForMatch(match);
        results[i] = { ok: true, match, prediction };
      } catch (err) {
        results[i] = { ok: false, match, error: err.message, cost: err.cost };
      }
      onProgress?.(i + 1, matches.length);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  const predictions = results.filter((r) => r.ok).map((r) => r.prediction);
  await savePredictions(predictions);
  return { predictions, failed: results.filter((r) => !r.ok) };
}

// ============================================================
// 3. WARSTWA PRZECHOWYWANIA — Cloudflare KV (przez worker) z fallbackiem na localStorage
// ============================================================
let kvAvailable = null; // null = nieznane, true/false po pierwszej próbie

async function savePredictions(newOnes) {
  const existing = await loadPredictions();
  const byId = new Map(existing.map((p) => [p.match_id, p]));
  for (const p of newOnes) byId.set(p.match_id, p);
  const merged = Array.from(byId.values());

  localStorage.setItem(STORAGE_KEY_PREDICTIONS, JSON.stringify(merged));

  if (kvAvailable !== false) {
    try {
      const res = await fetch(WORKER_URL + "/storage/predictions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(merged),
      });
      kvAvailable = res.ok;
    } catch {
      kvAvailable = false;
    }
  }
  return merged;
}

async function loadPredictions() {
  if (kvAvailable !== false) {
    try {
      const res = await fetch(WORKER_URL + "/storage/predictions");
      if (res.ok) {
        kvAvailable = true;
        const data = await res.json();
        if (Array.isArray(data) && data.length) {
          localStorage.setItem(STORAGE_KEY_PREDICTIONS, JSON.stringify(data));
        }
        return data || [];
      }
      kvAvailable = false;
    } catch {
      kvAvailable = false;
    }
  }
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY_PREDICTIONS) || "[]");
  } catch {
    return [];
  }
}

async function saveResults(results) {
  localStorage.setItem(STORAGE_KEY_RESULTS, JSON.stringify(results));
  if (kvAvailable !== false) {
    try {
      await fetch(WORKER_URL + "/storage/results", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(results),
      });
    } catch {
      /* localStorage zostaje jako backup */
    }
  }
}

async function loadResults() {
  if (kvAvailable !== false) {
    try {
      const res = await fetch(WORKER_URL + "/storage/results");
      if (res.ok) {
        const data = await res.json();
        if (data && Object.keys(data).length) {
          localStorage.setItem(STORAGE_KEY_RESULTS, JSON.stringify(data));
        }
        return data || {};
      }
    } catch {
      /* fallback niżej */
    }
  }
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY_RESULTS) || "{}");
  } catch {
    return {};
  }
}

function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ============================================================
// 4. RENDEROWANIE
// ============================================================
function formatDateShort(isoDate) {
  if (!isoDate) return "";
  const [, m, d] = isoDate.split("-");
  return `${d}.${m}`;
}

// Mecz jest "rozliczony", gdy oba zespoły mają wpisany rzeczywisty wynik.
function isSettled(match, results) {
  const r = results[match.match_id];
  return r && r.teamA_actual != null && r.teamB_actual != null;
}

function groupBy(arr, fn) {
  return arr.reduce((acc, item) => {
    const key = fn(item);
    (acc[key] ||= []).push(item);
    return acc;
  }, {});
}

async function renderBoard(container) {
  const allPredictions = await loadPredictions();
  const results = await loadResults();

  const pending = allPredictions.filter((p) => !isSettled(p, results));
  const settled = allPredictions.filter((p) => isSettled(p, results));

  if (!allPredictions.length) {
    container.innerHTML = `<div class="empty-state">Brak wygenerowanych predykcji. Wklej listę meczów powyżej i kliknij „Generuj predykcje”.</div>`;
  } else if (!pending.length) {
    container.innerHTML = `<div class="empty-state">Wszystkie mecze rozliczone — zobacz archiwum poniżej panelu Backtest.</div>`;
  } else {
    const byLeague = groupBy(pending, (p) => p.league);
    container.innerHTML = "";

    for (const [league, preds] of Object.entries(byLeague)) {
      const section = document.createElement("div");
      section.className = "league-section";
      section.innerHTML = `
        <div class="league-header">
          <span class="league-dot"></span>
          <h3>${league}</h3>
          <span class="count">(${preds.length} ${preds.length === 1 ? "mecz" : "meczów"})</span>
        </div>
      `;

      for (const p of preds) {
        section.appendChild(renderMatchRow(p, results[p.match_id]));
      }
      container.appendChild(section);
    }

    attachRowHandlers(container);
  }

  renderLambdaThresholdTable(document.getElementById("thresholdContainer"), settled, results);
  renderArchive(document.getElementById("archiveContainer"), settled, results);
}

function attachRowHandlers(container) {

  container.querySelectorAll(".match-row").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".result-form")) return;
      const id = row.dataset.id;
      const details = document.getElementById("details-" + id);
      const isOpen = details.style.display === "grid";
      details.style.display = isOpen ? "none" : "grid";
      row.classList.toggle("expanded", !isOpen);
    });
  });

  container.querySelectorAll(".result-form").forEach((form) => {
    form.addEventListener("click", (e) => e.stopPropagation());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const matchId = form.dataset.id;
      const input = form.querySelector('input[type="number"]');
      const fieldName = input.name; // "teamA_actual" albo "teamB_actual" - tylko jedno z nich istnieje w tym formularzu
      const value = Number(input.value);

      const results = await loadResults();
      const existing = results[matchId] || {};
      existing[fieldName] = value;
      existing.entered_at = new Date().toISOString();
      results[matchId] = existing;
      await saveResults(results);
      await renderBoard(container);
      renderBacktestPanel(document.getElementById("backtestContainer"), await runBacktestAudit());

      // Nie zwijaj z powrotem wiersza, który był otwarty w momencie zapisu
      const reopened = document.getElementById("details-" + matchId);
      const reopenedRow = container.querySelector(`.match-row[data-id="${matchId}"]`);
      if (reopened && reopenedRow) {
        reopened.style.display = "grid";
        reopenedRow.classList.add("expanded");
      }
    });
  });
}

function renderMatchRow(p, resultEntry) {
  const row = document.createElement("div");
  row.className = "match-row";
  row.dataset.id = p.match_id;

  const actualA = resultEntry?.teamA_actual;
  const actualB = resultEntry?.teamB_actual;
  const verdictsHtml =
    actualA == null && actualB == null
      ? `<span class="verdict-badge pending">⏳ Oczekuje</span>`
      : `${verdictBadgeHtml(p.teamA, actualA)} : ${verdictBadgeHtml(p.teamB, actualB)}`;

  row.innerHTML = `
    <span class="kickoff">${p.kickoff}<span class="match-date">${formatDateShort(p.date)}</span></span>
    <span class="teams">${p.teamA.name} vs ${p.teamB.name}</span>
    <span class="row-verdicts">${verdictsHtml}</span>
    <span class="quick-badges">
      ${quickBadge(p.teamA)}
      ${quickBadge(p.teamB)}
      ${lambdaSumBadgeHtml(p.teamA, p.teamB)}
      ${p._cost ? `<span class="pill pill-blue">$${p._cost.usd.toFixed(3)}</span>` : ""}
    </span>
    <button class="expand-btn" aria-label="Rozwiń szczegóły">⌄</button>
  `;

  const details = document.createElement("div");
  details.className = "details";
  details.id = "details-" + p.match_id;
  details.style.display = "none";
  details.innerHTML =
    renderTeamBlock(p.teamA, p.match_id, "teamA", resultEntry) +
    renderTeamBlock(p.teamB, p.match_id, "teamB", resultEntry);

  const container = document.createElement("div");
  container.appendChild(row);
  container.appendChild(details);
  return container;
}

// Lista meczów w pełni rozliczonych (oba wyniki wpisane) - pod panelem Backtest.
// Klikalna: rozwija te same szczegóły co na głównej liście, żeby móc np. poprawić literówkę w wyniku.
function renderArchive(container, settled, results) {
  if (!settled.length) {
    container.innerHTML = "";
    return;
  }

  const sorted = [...settled].sort((a, b) => (b.date + b.kickoff).localeCompare(a.date + a.kickoff));

  container.innerHTML = `<h2>Archiwum rozliczonych meczów (${sorted.length})</h2>`;

  for (const p of sorted) {
    const resultEntry = results[p.match_id];
    const verdictsHtml = `${verdictBadgeHtml(p.teamA, resultEntry.teamA_actual)} : ${verdictBadgeHtml(p.teamB, resultEntry.teamB_actual)}`;

    const row = document.createElement("div");
    row.className = "archive-row";
    row.dataset.id = p.match_id;
    row.innerHTML = `
      <span class="kickoff">${formatDateShort(p.date)}<span class="match-date">${p.kickoff}</span></span>
      <span class="teams">
        <span class="archive-league">${p.league}</span>
        ${p.teamA.name} vs ${p.teamB.name}
      </span>
      <span class="row-verdicts">
        ${lambdaSumBadgeHtml(p.teamA, p.teamB)}
        ${verdictsHtml}
      </span>
    `;

    const details = document.createElement("div");
    details.className = "details";
    details.id = "details-" + p.match_id;
    details.style.display = "none";
    details.innerHTML =
      renderTeamBlock(p.teamA, p.match_id, "teamA", resultEntry) +
      renderTeamBlock(p.teamB, p.match_id, "teamB", resultEntry);

    row.addEventListener("click", () => {
      const isOpen = details.style.display === "grid";
      details.style.display = isOpen ? "none" : "grid";
    });

    container.appendChild(row);
    container.appendChild(details);
  }
}

// Progi sprawdzane od najwyższego - pokazujemy tylko NAJWYŻSZY przekroczony próg,
// żeby uniknąć bałaganu wieloma badge'ami na raz.
const LAMBDA_THRESHOLDS = [5.5, 5.0, 4.5, 4.0, 3.5];

function lambdaSumBadgeHtml(teamA, teamB) {
  const sum = (teamA?.final_lambda || 0) + (teamB?.final_lambda || 0);
  const threshold = LAMBDA_THRESHOLDS.find((t) => sum > t);
  if (threshold == null) return "";
  return `<span class="pill pill-violet" title="λ_sum = ${sum.toFixed(2)}">&gt;${threshold.toFixed(1)}</span>`;
}

function quickBadge(team) {
  if (team.insufficient_data) return `<span class="pill pill-muted">brak danych</span>`;
  return `<span class="pill pill-gold">${team.top1} · ${team.top1_prob}%</span>`;
}

const CATS = ["0-1", "2", "3", "4+"];

function categoryFromCount(n) {
  if (n <= 1) return "0-1";
  if (n === 2) return "2";
  if (n === 3) return "3";
  return "4+";
}

// Liczy sam werdykt trafienia (bez HTML) - używane i w wierszu meczu, i w szczegółach.
function getVerdict(team, actualVal) {
  if (actualVal == null) return null; // brak wyniku jeszcze
  const actualCat = categoryFromCount(actualVal);
  const isExact = actualCat === team.top1;
  const isTop2 = isExact || actualCat === team.top2;
  return {
    actualCat,
    isExact,
    isTop2,
    cls: isExact ? "hit-exact" : isTop2 ? "hit-top2" : "hit-miss",
    text: isExact ? "🎯 TOP-1" : isTop2 ? "🟡 TOP-2" : "❌ Brak",
  };
}

function verdictBadgeHtml(team, actualVal) {
  const v = getVerdict(team, actualVal);
  if (!v) return `<span class="verdict-badge pending">⏳ Oczekuje</span>`;
  return `<span class="verdict-badge ${v.cls}">${v.text}</span>`;
}

// Trafność progu λ_sum: dla każdego progu sprawdza, ile rozliczonych meczów miało
// przewidywaną sumę λ (A+B) powyżej progu, i ile z nich rzeczywiście miało 4+ rożnych łącznie.
function computeLambdaThresholdAccuracy(settled, results) {
  return LAMBDA_THRESHOLDS.slice().reverse().map((threshold) => {
    const overThreshold = settled.filter((p) => {
      const sum = (p.teamA?.final_lambda || 0) + (p.teamB?.final_lambda || 0);
      return sum > threshold;
    });
    const hits = overThreshold.filter((p) => {
      const r = results[p.match_id];
      return (r.teamA_actual + r.teamB_actual) >= 4;
    });
    return {
      threshold,
      matchCount: overThreshold.length,
      hitCount: hits.length,
      accuracy: overThreshold.length ? hits.length / overThreshold.length : null,
    };
  });
}

function renderLambdaThresholdTable(container, settled, results) {
  if (!settled.length) {
    container.innerHTML = "";
    return;
  }
  const rows = computeLambdaThresholdAccuracy(settled, results);
  container.innerHTML = `
    <h2>Trafność progu λ_sum (suma λ obu drużyn → rzeczywiste 4+ rożnych łącznie w 1H)</h2>
    <table class="threshold-table">
      <thead>
        <tr><th>Próg</th><th>Meczów nad progiem</th><th>Trafień (≥4 rzecz.)</th><th>Trafność</th></tr>
      </thead>
      <tbody>
        ${rows.map((r) => `
          <tr>
            <td>&gt;${r.threshold.toFixed(1)}</td>
            <td>${r.matchCount}</td>
            <td>${r.matchCount ? r.hitCount : "—"}</td>
            <td>${r.accuracy == null ? "—" : Math.round(r.accuracy * 100) + "%"}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

// Renderuje albo formularz do wpisania wyniku, albo (jeśli wynik już jest)
// zapisaną wartość + werdykt trafienia (TOP-1 / TOP-2 / brak trafienia),
// dokładnie wg logiki z sekcji 37 Master Promptu (exact hit / top-2 hit).
function renderResultBlock(team, matchId, teamKey, resultEntry) {
  const actualKey = teamKey === "teamA" ? "teamA_actual" : "teamB_actual";
  const actualVal = resultEntry?.[actualKey];

  if (actualVal == null) {
    return `
      <form class="result-form" data-id="${matchId}">
        <label>Rzeczywiste rożne 1H:</label>
        <input type="number" min="0" name="${actualKey}" required>
        <button type="submit" class="btn btn-outline" style="padding:3px 10px;">Zapisz</button>
      </form>
    `;
  }

  const v = getVerdict(team, actualVal);
  const verdictText = v.isExact ? "🎯 Trafienie TOP-1" : v.isTop2 ? "🟡 Trafienie TOP-2" : "❌ Brak trafienia";

  return `
    <div class="result-verdict">
      <span class="saved-tag">✓ Rzeczywisty wynik: ${actualVal} (kategoria ${v.actualCat})</span>
      <span class="verdict-badge ${v.cls}">${verdictText}</span>
    </div>
  `;
}

function renderTeamBlock(team, matchId, teamKey, resultEntry) {
  const dist = team.distribution || {};
  const maxVal = Math.max(...CATS.map((c) => dist[c] || 0), 1);

  const distRows = CATS.map((c) => {
    const val = dist[c] || 0;
    const cls = c === team.top1 ? "is-top1" : c === team.top2 ? "is-top2" : "";
    return `
      <div class="dist-row">
        <span class="dist-label">${c}</span>
        <span class="dist-track"><span class="dist-fill ${cls}" style="width:${(val / maxVal) * 100}%"></span></span>
        <span class="dist-value">${val}%</span>
      </div>
    `;
  }).join("");

  const argsList = (team.arguments || [])
    .slice(0, 5)
    .map((a) => `<li>${escapeHtml(a)}</li>`)
    .join("");
  const risksList = (team.risks || [])
    .slice(0, 5)
    .map((r) => `<li>${escapeHtml(r)}</li>`)
    .join("");

  const actualKey = teamKey === "teamA" ? "teamA_actual" : "teamB_actual";
  const resultBlock = renderResultBlock(team, matchId, teamKey, resultEntry);

  return `
    <div class="team-block">
      <div class="team-block-head">
        <span class="team-name">
          ${escapeHtml(team.name)}
          ${team.insufficient_data ? `<span class="insufficient-flag">INSUFFICIENT DATA</span>` : ""}
        </span>
        <span class="lambda">${team.final_lambda?.toFixed(2) ?? "–"}<span>λ</span></span>
      </div>

      ${distRows}

      <div class="pick-line">
        <span>TOP 1: <strong>${team.top1}</strong> (${team.top1_prob}%)</span>
        <span>TOP 2: ${team.top2} (${team.top2_prob}%)</span>
      </div>

      <div class="confidence-meter">
        <span>Confidence</span>
        <span class="confidence-track"><span class="confidence-fill" style="width:${team.confidence || 0}%"></span></span>
        <span>${team.confidence ?? "–"}/100</span>
      </div>

      ${argsList ? `<div class="section-label">Argumenty</div><ul class="mini-list">${argsList}</ul>` : ""}
      ${risksList ? `<div class="section-label">Ryzyko</div><ul class="mini-list risks">${risksList}</ul>` : ""}

      ${resultBlock}
    </div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================
// 5. UPLOAD WYNIKÓW Z PLIKU JSON
// ============================================================
function handleResultsFileUpload(file, onDone) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const parsed = JSON.parse(reader.result);
      const list = Array.isArray(parsed) ? parsed : Object.values(parsed);
      const results = await loadResults();
      for (const r of list) {
        if (!r.match_id) continue;
        results[r.match_id] = {
          teamA_actual: r.teamA_actual,
          teamB_actual: r.teamB_actual,
          entered_at: new Date().toISOString(),
        };
      }
      await saveResults(results);
      onDone?.(results);
    } catch (e) {
      alert("Błąd parsowania pliku JSON: " + e.message);
    }
  };
  reader.readAsText(file);
}

// ============================================================
// 6. BACKTEST AUDIT (czysta matematyka — sekcje 37-41 Master Promptu)
// ============================================================
function brierScoreForCategory(distribution, actualCat) {
  let sum = 0;
  for (const c of CATS) {
    const p = (distribution?.[c] ?? 0) / 100;
    const o = c === actualCat ? 1 : 0;
    sum += (p - o) ** 2;
  }
  return sum;
}

async function runBacktestAudit() {
  const predictions = await loadPredictions();
  const results = await loadResults();

  const rows = [];
  for (const p of predictions) {
    const r = results[p.match_id];
    if (!r) continue;

    for (const [teamKey, actualKey] of [["teamA", "teamA_actual"], ["teamB", "teamB_actual"]]) {
      const team = p[teamKey];
      const actualCount = r[actualKey];
      if (actualCount == null || !team) continue;

      const actualCat = categoryFromCount(actualCount);
      rows.push({
        match_id: p.match_id,
        team: team.name,
        predicted_top1: team.top1,
        actual_category: actualCat,
        exact_hit: actualCat === team.top1,
        top2_hit: actualCat === team.top1 || actualCat === team.top2,
        confidence: team.confidence,
        brier_score: brierScoreForCategory(team.distribution, actualCat),
      });
    }
  }

  const n = rows.length;
  return {
    sample_size: n,
    exact_hit_rate: n ? rows.filter((r) => r.exact_hit).length / n : null,
    top2_hit_rate: n ? rows.filter((r) => r.top2_hit).length / n : null,
    avg_brier_score: n ? rows.reduce((s, r) => s + r.brier_score, 0) / n : null,
    rows,
  };
}

function renderBacktestPanel(container, audit) {
  if (!audit.sample_size) {
    container.innerHTML = `<h2>Backtest</h2><div class="empty-state">Brak jeszcze sparowanych wyników — wprowadź rzeczywiste rożne przy meczach lub wgraj plik JSON.</div>`;
    return;
  }
  const pct = (x) => (x == null ? "–" : Math.round(x * 100) + "%");
  container.innerHTML = `
    <h2>Backtest</h2>
    <div class="scoreboard">
      <div class="score-cell"><div class="value">${audit.sample_size}</div><div class="label">próbka (drużyny)</div></div>
      <div class="score-cell"><div class="value">${pct(audit.exact_hit_rate)}</div><div class="label">exact hit</div></div>
      <div class="score-cell"><div class="value">${pct(audit.top2_hit_rate)}</div><div class="label">top-2 hit</div></div>
      <div class="score-cell"><div class="value">${audit.avg_brier_score?.toFixed(3) ?? "–"}</div><div class="label">śr. Brier score</div></div>
    </div>
  `;
}

// ============================================================
// 7. INICJALIZACJA STRONY
// ============================================================
document.addEventListener("DOMContentLoaded", async () => {
  const matchListInput = document.getElementById("matchListInput");
  const parseBtn = document.getElementById("parseBtn");
  const generateBtn = document.getElementById("generateBtn");
  const downloadBtn = document.getElementById("downloadPredictionsBtn");
  const resultsUpload = document.getElementById("resultsUpload");
  const boardContainer = document.getElementById("boardContainer");
  const backtestContainer = document.getElementById("backtestContainer");
  const statusLine = document.getElementById("statusLine");

  let currentMatches = [];

  parseBtn.addEventListener("click", () => {
    currentMatches = parseMatchList(matchListInput.value);
    statusLine.textContent = `Znaleziono ${currentMatches.length} meczów — gotowe do generowania.`;
    generateBtn.disabled = currentMatches.length === 0;
  });

  generateBtn.addEventListener("click", async () => {
    generateBtn.disabled = true;
    const { predictions, failed } = await generateAllPredictions(currentMatches, {
      onProgress: (done, total) => {
        statusLine.textContent = `Generowanie predykcji: ${done}/${total}...`;
      },
    });
    const totalCost = predictions.reduce((sum, p) => sum + (p._cost?.usd || 0), 0);
    const totalSearches = predictions.reduce((sum, p) => sum + (p._cost?.web_searches || 0), 0);
    const failedCost = failed.reduce((sum, f) => sum + (f.cost?.usd || 0), 0);
    if (failed.length) {
      statusLine.innerHTML = `Błąd (${failed.length}): <strong>${escapeHtml(failed[0].error)}</strong>` +
        ` — Koszt TEJ nieudanej próby: $${failedCost.toFixed(4)}` +
        (predictions.length ? `, koszt udanych: $${totalCost.toFixed(3)}` : "");
      console.warn("Nieudane predykcje:", failed);
    } else {
      statusLine.textContent = `Gotowe — ${predictions.length} meczów. Koszt: $${totalCost.toFixed(3)} (${totalSearches} wyszukiwań, śr. $${(totalCost / (predictions.length || 1)).toFixed(3)}/mecz).`;
    }
    generateBtn.disabled = false;
    await renderBoard(boardContainer);
    renderBacktestPanel(backtestContainer, await runBacktestAudit());
  });

  downloadBtn.addEventListener("click", async () => {
    downloadJSON(await loadPredictions(), "predictions.json");
  });

  resultsUpload.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    handleResultsFileUpload(file, async () => {
      statusLine.textContent = "Wyniki wgrane z pliku JSON.";
      await renderBoard(boardContainer);
      renderBacktestPanel(backtestContainer, await runBacktestAudit());
    });
    e.target.value = "";
  });

  await renderBoard(boardContainer);
  renderBacktestPanel(backtestContainer, await runBacktestAudit());
});
