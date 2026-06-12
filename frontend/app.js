// ─── CONFIG ────────────────────────────────────────────────────────────────
// Replace this with your deployed Worker URL after running `wrangler deploy`
const WORKER_URL = "";
// ───────────────────────────────────────────────────────────────────────────

let fights = [];
let selectedFight = null;
let assignments = [];
const analysisCache = new Map(); // keyed by `${code}:${fightId}:${sortedSpellIds}`
let reportPhases = [];
try { assignments = JSON.parse(localStorage.getItem('cd-checker-assignments') || '[]'); } catch(_) {}
renderAssignments();

document.getElementById('tolerance').addEventListener('input', function() {
  document.getElementById('tolHint').textContent = this.value;
});

function parseTime(str) {
  str = str.trim();
  const parts = str.split(':');
  if (parts.length === 2) return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
  return parseFloat(str);
}

function fmtTime(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

function normalizePhaseId(value) {
  const raw = value && typeof value === 'object' ? value.id : value;
  const phase = Number(raw);
  return Number.isFinite(phase) && phase > 0 ? phase : null;
}

function assignmentPhaseId(assign) {
  if (assign.phase === undefined || assign.phase === null || assign.phase === '') return null;
  return normalizePhaseId(assign.phase);
}

function eventPhaseId(ev) {
  return normalizePhaseId(ev.phase ?? ev.phaseID ?? ev.phaseId ?? ev.phase_id);
}

function eventFightId(ev) {
  const fight = Number(ev.fight);
  return Number.isFinite(fight) ? fight : null;
}

function phaseAtTime(ms, phaseWindows) {
  const match = Object.entries(phaseWindows).find(([, window]) =>
    ms >= window.start && ms < window.end
  );
  return match ? Number(match[0]) : null;
}

function extractCode(url) {
  const m = url.match(/reports\/([A-Za-z0-9]+)/);
  if (!m) throw new Error('Could not find a report code in that URL.');
  return m[1];
}

function extractFightParam(url) {
  try {
    const u = new URL(url);
    const f = u.searchParams.get('fight');
    if (!f) return 'last';
    if (f === 'last') return 'last';
    const n = parseInt(f);
    return isNaN(n) ? 'last' : n;
  } catch { return 'last'; }
}

async function wcl(query, variables = {}) {
  const resp = await fetch(`${WORKER_URL}/api/wcl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const json = await resp.json();
  if (json.error) throw new Error(json.error);
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

function showError(el, msg) {
  document.getElementById(el).innerHTML = `<div class="error-box">${msg}</div>`;
}
function clearError(el) {
  document.getElementById(el).innerHTML = '';
}

document.getElementById('logUrl').addEventListener('change', async function() {
  const url = this.value.trim();
  if (!url) return;
  clearError('log-error');
  document.getElementById('fight-picker').style.display = 'none';
  try {
    const code = extractCode(url);
    const data = await wcl(
      `query($code:String!){reportData{report(code:$code){phases{encounterID phases{id name isIntermission}} fights(killType:All){id name startTime endTime encounterID phaseTransitions{id startTime}}}}}`,
      { code }
    );
    fights = data.reportData.report.fights;
    reportPhases = data.reportData.report.phases || [];
    if (!fights.length) { showError('log-error', 'No fights found in this report.'); return; }
    const sel = document.getElementById('fightSelect');
    sel.innerHTML = fights.map(f =>
      `<option value="${f.id}">${f.name} (${fmtTime(f.endTime - f.startTime)})</option>`
    ).join('');
    const fightParam = extractFightParam(url);
    if (fightParam === 'last') {
      selectedFight = fights[fights.length - 1];
    } else {
      selectedFight = fights.find(f => f.id === fightParam) || fights[fights.length - 1];
    }
    sel.value = selectedFight.id;
    document.getElementById('fightHint').textContent = `${fights.length} fight(s) — selected: ${selectedFight.name}`;
    document.getElementById('fight-picker').style.display = 'block';
  } catch(e) {
    showError('log-error', e.message);
  }
});

function loadFight() {
  const id = parseInt(document.getElementById('fightSelect').value);
  selectedFight = fights.find(f => f.id === id) || fights[0];
}

// ─── Assignments ────────────────────────────────────────────────────────────

function renderAssignments() {
  const tbody = document.getElementById('assignBody');
  tbody.innerHTML = '';
  assignments.forEach((a, i) => {
    const tr = document.createElement('tr');
    const timeDisplay = a.phase !== undefined ? `p${a.phase}+${a.time}s` : a.time;
    const spellDisplay = a.spellId ? (a.spell || `ID:${a.spellId}`) : (a.spell || '');
    tr.innerHTML = `<td>${escHtml(String(timeDisplay))}</td><td>${escHtml(a.player)}</td><td>${escHtml(spellDisplay)}</td>
      <td><button class="del-btn" onclick="removeRow(${i})">×</button></td>`;
    tbody.appendChild(tr);
  });
}

function addRow() {
  const t = document.getElementById('newTime').value.trim();
  const p = document.getElementById('newPlayer').value.trim();
  const s = document.getElementById('newSpell').value.trim();
  if (!t || !p || !s) return;
  assignments.push({ time: t, player: p, spell: s });
  renderAssignments();
  saveAssignments();
  ['newTime','newPlayer','newSpell'].forEach(id => document.getElementById(id).value = '');
}

function removeRow(i) {
  assignments.splice(i, 1);
  renderAssignments();
  saveAssignments();
}

function saveAssignments() {
  localStorage.setItem('cd-checker-assignments', JSON.stringify(assignments));
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toggleMrtArea() {
  const area = document.getElementById('mrtArea');
  area.style.display = area.style.display === 'none' ? 'block' : 'none';
}

function parseMrtNote(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const result = [];
  for (const line of lines) {
    if (line.startsWith('EncounterID:') || line.startsWith('#')) continue;
    const props = {};
    line.split(';').forEach(part => {
      const idx = part.indexOf(':');
      if (idx > 0) props[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    });
    if (!props.tag || !props.spellid || props.time === undefined || !props.ph) continue;
    if (props.tag === 'everyone') continue;
    result.push({
      phase: parseInt(props.ph),
      time: parseInt(props.time),
      player: props.tag,
      spellId: parseInt(props.spellid),
      spell: '',
    });
  }
  return result;
}

function importMrt() {
  const text = document.getElementById('mrtInput').value.trim();
  if (!text) return;
  const parsed = parseMrtNote(text);
  if (!parsed.length) return;
  assignments = parsed;
  renderAssignments();
  saveAssignments();
  document.getElementById('mrtArea').style.display = 'none';
  document.getElementById('mrtInput').value = '';
}

// ─── Main analysis ──────────────────────────────────────────────────────────

async function runCheck() {
  const main = document.getElementById('mainArea');
  main.innerHTML = '<div class="loading"><div class="spinner"></div> Fetching cast events…</div>';

  try {
    if (!assignments.length) throw new Error('Add at least one cooldown assignment first.');
    const url = document.getElementById('logUrl').value.trim();
    if (!url) throw new Error('Paste a WarcraftLogs report URL first.');
    const code = extractCode(url);

    if (!selectedFight) {
      const data = await wcl(
        `query($code:String!){reportData{report(code:$code){phases{encounterID phases{id name isIntermission}} fights(killType:All){id name startTime endTime encounterID phaseTransitions{id startTime}}}}}`,
        { code }
      );
      fights = data.reportData.report.fights;
      reportPhases = data.reportData.report.phases || [];
      selectedFight = fights[fights.length - 1];
      if (!selectedFight) throw new Error('No fights found in this report. Paste the URL above and select a fight first.');
    }

    const fight = selectedFight;
    const tolerance = parseInt(document.getElementById('tolerance').value) * 1000;

    // Phase map from fight object — already fetched during URL load, no extra API call
    const phaseStartMap = { 1: 0 };
    (fight.phaseTransitions || []).forEach(pt => {
      phaseStartMap[pt.id] = pt.startTime - fight.startTime;
    });

    // Phase name map for this fight's encounter (e.g. {1: {name:'Stage One', intermission:false}, ...})
    const phaseNameMap = {};
    (reportPhases || []).filter(p => p.encounterID === fight.encounterID).forEach(p => {
      (p.phases || []).forEach(pm => {
        phaseNameMap[pm.id] = { name: pm.name, intermission: !!pm.isIntermission };
      });
    });

    // Cache API results by report + fight + spell IDs so re-clicking Analyze is free
    const assignmentSpellIds = [...new Set(assignments.filter(a => a.spellId).map(a => a.spellId))].sort();
    const cacheKey = `${code}:${fight.id}:${assignmentSpellIds.join(',')}`;
    let actorMap, spellIdToName, fightPlayerNames, rawEvents;

    if (analysisCache.has(cacheKey)) {
      ({ actorMap, spellIdToName, fightPlayerNames, rawEvents } = analysisCache.get(cacheKey));
    } else {
      // Pass spell IDs as a server-side filter so WCL only returns the events we need
      const filterExpr = assignmentSpellIds.length > 0
        ? `ability.id in (${assignmentSpellIds.join(',')})`
        : null;
      const castData = await wcl(
        `query($code:String!,$start:Float!,$end:Float!${filterExpr ? ',$filter:String!' : ''}){
          reportData{report(code:$code){
            masterData{ actors{ id name } abilities{ gameID name } }
            combatants: events(dataType:CombatantInfo,startTime:$start,endTime:$end,limit:100){data}
            casts: events(dataType:Casts,startTime:$start,endTime:$end,limit:10000${filterExpr ? ',filterExpression:$filter' : ''}){data}
          }}
        }`,
        { code, start: fight.startTime, end: fight.endTime, ...(filterExpr ? { filter: filterExpr } : {}) }
      );
      const actors = castData.reportData.report.masterData?.actors || [];
      actorMap = Object.fromEntries(actors.map(a => [a.id, a.name]));
      const abilities = castData.reportData.report.masterData?.abilities || [];
      spellIdToName = Object.fromEntries(abilities.map(a => [a.gameID, a.name]));
      const combatantEvents = castData.reportData.report.combatants?.data || [];
      const fightPlayerIds = new Set(combatantEvents.map(e => e.sourceID).filter(Boolean));
      fightPlayerNames = new Set([...fightPlayerIds].map(id => actorMap[id]).filter(Boolean));
      rawEvents = castData.reportData.report.casts?.data || [];
      analysisCache.set(cacheKey, { actorMap, spellIdToName, fightPlayerNames, rawEvents });
    }

    // Only check assignments for players present in this fight
    const activeAssignments = assignments.filter(assign =>
      [...fightPlayerNames].some(name => name.toLowerCase().includes(assign.player.toLowerCase()))
    );

    const fightStart = fight.startTime;
    const fightDur = fight.endTime - fight.startTime;

    // Pre-compute each phase's time window [start, end) so casts can't bleed across phases
    const sortedPhaseIds = Object.keys(phaseStartMap).map(Number).sort((a, b) => phaseStartMap[a] - phaseStartMap[b]);
    const phaseWindows = {};
    sortedPhaseIds.forEach((id, i) => {
      phaseWindows[id] = {
        start: phaseStartMap[id],
        end: i + 1 < sortedPhaseIds.length ? phaseStartMap[sortedPhaseIds[i + 1]] : fightDur
      };
    });

    // WCL cast events usually do not include phase, so derive it from their report timestamp.
    const relevantCasts = rawEvents
      .filter(ev => eventFightId(ev) === null || eventFightId(ev) === fight.id)
      .map(ev => {
        const time = ev.timestamp - fightStart;
        return {
          time,
          phase: eventPhaseId(ev) ?? phaseAtTime(time, phaseWindows),
          ability: spellIdToName[ev.abilityGameID] || '',
          abilityId: ev.abilityGameID,
          source: actorMap[ev.sourceID] || 'Unknown'
        };
      });

    const results = activeAssignments
      .filter(assign => {
        const assignPhase = assignmentPhaseId(assign);
        // Drop assignments for phases that never started in this attempt
        if (assignPhase !== null && !(assignPhase in phaseStartMap)) return false;
        // Drop assignments due after the fight ended (fight ended too early)
        const ms = assignPhase !== null
          ? phaseStartMap[assignPhase] + assign.time * 1000
          : parseTime(String(assign.time)) * 1000;
        return ms < fightDur;
      })
      .map(assign => {
        const assignPhase = assignmentPhaseId(assign);
        const assignedMs = assignPhase !== null
          ? phaseStartMap[assignPhase] + assign.time * 1000
          : parseTime(String(assign.time)) * 1000;

        const window = assignPhase !== null ? phaseWindows[assignPhase] : null;
        const matching = relevantCasts.filter(c => {
          if (!c.source.toLowerCase().includes(assign.player.toLowerCase())) return false;
          const spellMatch = assign.spellId
            ? c.abilityId === assign.spellId
            : c.ability.toLowerCase().includes((assign.spell || '').toLowerCase());
          if (!spellMatch) return false;
          if (assignPhase !== null && c.phase !== assignPhase) return false;
          // Restrict to the phase's time window so same-spell casts from other phases don't match
          if (window && (c.time < window.start || c.time >= window.end)) return false;
          return true;
        });

        const resolvedName = assign.spellId ? spellIdToName[assign.spellId] : null;
        if (!matching.length) return { assign, status: 'missed', actual: null, delta: null, assignedMs, spellName: resolvedName };
        const closest = matching.reduce((best, c) =>
          Math.abs(c.time - assignedMs) < Math.abs(best.time - assignedMs) ? c : best
        );
        const delta = closest.time - assignedMs;
        const status = Math.abs(delta) <= tolerance ? 'ok' : delta > 0 ? 'late' : 'early';
        return { assign, status, actual: closest, delta, assignedMs,
          spellName: closest.ability || resolvedName };
      });

    renderResults(results, fight, fightDur, tolerance, phaseNameMap, phaseStartMap);
  } catch(e) {
    document.getElementById('mainArea').innerHTML = `<div class="error-box">⚠ ${escHtml(e.message)}</div>`;
  }
}

// ─── Render results ─────────────────────────────────────────────────────────

function renderResults(results, fight, fightDur, tolerance, phaseNameMap = {}, phaseStartMap = {}) {
  const counts = { ok: 0, late: 0, early: 0, missed: 0 };
  results.forEach(r => counts[r.status]++);

  const pct = val => Math.min(100, Math.max(0, (val / fightDur) * 100)).toFixed(2);

  const badges = { ok: 'badge-ok', late: 'badge-late', early: 'badge-early', missed: 'badge-missed' };
  const labels = {
    ok: r => 'On time',
    late: r => `+${Math.round(r.delta / 1000)}s late`,
    early: r => `${Math.round(r.delta / 1000)}s early`,
    missed: r => 'Missed'
  };

  // Thin vertical lines on every timeline bar showing when each phase started
  const phaseMarkers = Object.entries(phaseStartMap)
    .filter(([, time]) => time > 0 && time < fightDur)
    .map(([id, time]) => {
      const pi = phaseNameMap[parseInt(id)];
      return `<div class="tl-phase" style="left:${pct(time)}%" title="${pi ? escHtml(pi.name) : 'Phase ' + id}"></div>`;
    }).join('');

  // Build rows with a phase-section header injected each time the phase changes
  let rows = '';
  let lastPhase = undefined;
  results.forEach(r => {
    const ph = r.assign.phase;
    if (ph !== undefined && ph !== lastPhase) {
      lastPhase = ph;
      const pi = phaseNameMap[ph];
      const phaseName = pi ? pi.name : `Phase ${ph}`;
      const phaseTime = phaseStartMap[ph];
      const timeLabel = phaseTime !== undefined ? `<span class="phase-time">${fmtTime(phaseTime)}</span>` : '';
      rows += `<div class="phase-divider${pi?.intermission ? ' intermission' : ''}">${escHtml(phaseName)}${timeLabel}</div>`;
    }
    const phaseLabel = ph !== undefined
      ? escHtml((phaseNameMap[ph]?.name || 'P' + ph) + ' +' + r.assign.time + 's')
      : escHtml(String(r.assign.time));
    const winL = pct(r.assignedMs - tolerance);
    const winW = pct(Math.min(r.assignedMs + tolerance, fightDur) - Math.max(r.assignedMs - tolerance, 0));
    rows += `
      <div class="result-item">
        <div class="result-row">
          <span style="color:var(--muted)">${phaseLabel}</span>
          <span>${escHtml(r.assign.player)}</span>
          <span>${escHtml(r.spellName || r.assign.spell || (r.assign.spellId ? 'ID:' + r.assign.spellId : '—'))}</span>
          <span style="color:var(--muted)">${r.actual ? fmtTime(r.actual.time) : '—'}</span>
          <span><span class="badge ${badges[r.status]}">${labels[r.status](r)}</span></span>
        </div>
        <div class="tl-wrap"><div class="timeline">
          ${phaseMarkers}
          <div class="tl-window tl-window-${r.status}" style="left:${winL}%;width:${winW}%"></div>
          <div class="tl-assigned" style="left:${pct(r.assignedMs)}%"></div>
          ${r.actual ? `<div class="tl-actual tl-actual-${r.status}" style="left:${pct(r.actual.time)}%"></div>` : ''}
        </div></div>
      </div>`;
  });

  // Show the last phase reached in the fight header
  const maxPhaseId = Math.max(...Object.keys(phaseStartMap).map(Number));
  const lastPhaseName = phaseNameMap[maxPhaseId]?.name;
  const phaseReachedLabel = lastPhaseName && maxPhaseId > 1
    ? `<span class="dur">→ ${escHtml(lastPhaseName)}</span>` : '';

  document.getElementById('mainArea').innerHTML = `
    <div class="fight-title">
      ${escHtml(fight.name)}
      <span class="dur">${fmtTime(fight.endTime - fight.startTime)}</span>
      ${phaseReachedLabel}
    </div>
    <div class="summary-grid">
      <div class="stat stat-ok"><div class="stat-num">${counts.ok}</div><div class="stat-lbl">On time</div></div>
      <div class="stat stat-late"><div class="stat-num">${counts.late + counts.early}</div><div class="stat-lbl">Off timing</div></div>
      <div class="stat stat-missed"><div class="stat-num">${counts.missed}</div><div class="stat-lbl">Missed</div></div>
      <div class="stat"><div class="stat-num">${results.length}</div><div class="stat-lbl">Total</div></div>
    </div>
    <div class="results-table-wrap">
      <div class="results-header">
        <span>Assigned</span><span>Player</span><span>Spell</span><span>Actual</span><span>Status</span>
      </div>
      ${rows}
    </div>`;
}
