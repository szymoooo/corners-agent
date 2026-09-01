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

  // Nagłówek ligi: dowolny tekst zakończony "(<liczba> mecz...)", emoji 🏆 opcjonalne.
  const leagueRe = /^(?:🏆\s*)?(.+?)\s*\(\s*\d+\s*mecz/iu;
  // Wiersz meczu: godzina (HH:MM lub HH.MM), potem dwie nazwy drużyn rozdzielone " vs ",
  // z tolerancją na dowolne "śmieci" na końcu (emoji, strzałki, spacje) po drugiej drużynie.
  const matchRe = /^(\d{1,2}[:.]\d{2})\s*[-–—]?\s*(.+?)\s+vs\.?\s+(.+?)\s*[^\p{L}\p{N}).\]]*$/iu;

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
      league: match.league,
      kickoff: match.kickoff,
      date: match.date,
      teamA: match.teamA,
      teamB: match.teamB,
      side,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error + (data.detail ? ": " + data.detail : ""));
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
        results[i] = { ok: false, match, error: err.message };
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
function groupBy(arr, fn) {
  return arr.reduce((acc, item) => {
    const key = fn(item);
    (acc[key] ||= []).push(item);
    return acc;
  }, {});
}

async function renderBoard(container) {
  const predictions = await loadPredictions();
  const results = await loadResults();

  if (!predictions.length) {
    container.innerHTML = `<div class="empty-state">Brak wygenerowanych predykcji. Wklej listę meczów powyżej i kliknij „Generuj predykcje”.</div>`;
    return;
  }

  const byLeague = groupBy(predictions, (p) => p.league);
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
      const teamA_actual = Number(form.querySelector('[name="teamA_actual"]').value);
      const teamB_actual = Number(form.querySelector('[name="teamB_actual"]').value);
      const results = await loadResults();
      results[matchId] = { teamA_actual, teamB_actual, entered_at: new Date().toISOString() };
      await saveResults(results);
      form.innerHTML = `<span class="saved-tag">✓ Zapisano wynik: ${teamA_actual} — ${teamB_actual}</span>`;
    });
  });
}

function renderMatchRow(p, resultEntry) {
  const row = document.createElement("div");
  row.className = "match-row";
  row.dataset.id = p.match_id;

  row.innerHTML = `
    <span class="kickoff">${p.kickoff}</span>
    <span class="teams">${p.teamA.name} vs ${p.teamB.name}</span>
    <span class="quick-badges">
      ${quickBadge(p.teamA)}
      ${quickBadge(p.teamB)}
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

function quickBadge(team) {
  if (team.insufficient_data) return `<span class="pill pill-muted">brak danych</span>`;
  return `<span class="pill pill-gold">${team.top1} · ${team.top1_prob}%</span>`;
}

const CATS = ["0-1", "2", "3", "4+"];

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
  const resultBlock = resultEntry && resultEntry[actualKey] != null
    ? `<span class="saved-tag">✓ Rzeczywisty wynik: ${resultEntry[actualKey]}</span>`
    : `
      <form class="result-form" data-id="${matchId}">
        <label>Rzeczywiste rożne 1H:</label>
        <input type="number" min="0" name="${actualKey}" required>
        <button type="submit" class="btn btn-outline" style="padding:3px 10px;">Zapisz</button>
      </form>
    `;

  return `
    <div class="team-block">
      <div class="team-block-head">
        <span class="team-name">${escapeHtml(team.name)}</span>
        <span class="lambda">${team.final_lambda?.toFixed(2) ?? "–"}<span>λ</span></span>
      </div>

      ${team.insufficient_data ? `<span class="insufficient-flag">INSUFFICIENT DATA</span>` : ""}

      ${distRows}

      <div class="pick-line">
        <span>Typ: <strong>${team.top1}</strong> (${team.top1_prob}%)</span>
        <span>2. wybór: ${team.top2} (${team.top2_prob}%)</span>
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
function categoryFromCount(n) {
  if (n <= 1) return "0-1";
  if (n === 2) return "2";
  if (n === 3) return "3";
  return "4+";
}

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
    statusLine.textContent = failed.length
      ? `Gotowe. Błędy dla ${failed.length} meczów (zobacz konsolę). Koszt udanych: $${totalCost.toFixed(3)} (${totalSearches} wyszukiwań).`
      : `Gotowe — ${predictions.length} meczów. Koszt: $${totalCost.toFixed(3)} (${totalSearches} wyszukiwań, śr. $${(totalCost / (predictions.length || 1)).toFixed(3)}/mecz).`;
    if (failed.length) console.warn("Nieudane predykcje:", failed);
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