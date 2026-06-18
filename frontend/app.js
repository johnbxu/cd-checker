const API_BASE_URL = "";

let fights = [];
let selectedFight = null;
let assignments = [];
const analysisCache = new Map(); // keyed by `${code}:${fightId}:${sortedSpellIds}`
const mechanicEventCache = new Map(); // keyed by `${code}:${fightId}:${kind}`
const PERSISTENT_CACHE_DB = 'cd-checker-cache';
const PERSISTENT_CACHE_STORE = 'responses';
const PERSISTENT_CACHE_VERSION = 1;
const PERSISTENT_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
let persistentCachePromise = null;
let reportPhases = [];
let loadedReportCode = null;
let activeResultFilter = 'all';
let lastRenderContext = null;
let lastMechanicRenderData = null;
let mechanicSummarySort = 'damage';
try { assignments = JSON.parse(localStorage.getItem('cd-checker-assignments') || '[]'); } catch(_) {}
renderAssignments();

const MIDNIGHT_FALLS = {
  fightName: 'Midnight Falls',
  trackedDamage: [
    "Heaven's Glaives",
    'Dark Quasar',
    'Void Swarm',
    'The Darkwell'
  ],
  groupedDamage: [
    "Heaven's Glaives",
    'Dark Quasar'
  ],
  groupedDamageWindowMs: 1500,
  starsplinter: 'Starsplinter',
  starsplinterSplashMinDamage: 300000,
  galvanize: 'Galvanize',
  midnight: 'Midnight',
  galvanizePhase: 2,
  midnightPhase: 4,
  galvanizeWindowMs: 1500
};

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

function buildFightContext(fight) {
  const phaseStartMap = { 1: 0 };
  (fight.phaseTransitions || []).forEach(pt => {
    phaseStartMap[pt.id] = pt.startTime - fight.startTime;
  });

  const phaseNameMap = {};
  (reportPhases || []).filter(p => p.encounterID === fight.encounterID).forEach(p => {
    (p.phases || []).forEach(pm => {
      phaseNameMap[pm.id] = { name: pm.name, intermission: !!pm.isIntermission };
    });
  });

  const fightDur = fight.endTime - fight.startTime;
  const sortedPhaseIds = Object.keys(phaseStartMap).map(Number).sort((a, b) => phaseStartMap[a] - phaseStartMap[b]);
  const phaseWindows = {};
  sortedPhaseIds.forEach((id, i) => {
    phaseWindows[id] = {
      start: phaseStartMap[id],
      end: i + 1 < sortedPhaseIds.length ? phaseStartMap[sortedPhaseIds[i + 1]] : fightDur
    };
  });

  return { phaseStartMap, phaseNameMap, phaseWindows, fightDur };
}

function phaseTimeLabel(ms, phaseWindows, phaseNameMap = {}) {
  const phase = phaseAtTime(ms, phaseWindows);
  if (phase === null || !phaseWindows[phase]) return fmtTime(ms);
  const label = phaseNameMap[phase]?.name || `P${phase}`;
  return `${label} +${Math.round((ms - phaseWindows[phase].start) / 1000)}s`;
}

function extractCode(url) {
  const m = url.match(/reports\/([A-Za-z0-9]+)/);
  if (!m) throw new Error('Could not find a report code in that URL.');
  return m[1];
}

function openPersistentCache() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (persistentCachePromise) return persistentCachePromise;
  persistentCachePromise = new Promise(resolve => {
    const request = indexedDB.open(PERSISTENT_CACHE_DB, PERSISTENT_CACHE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PERSISTENT_CACHE_STORE)) {
        db.createObjectStore(PERSISTENT_CACHE_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  return persistentCachePromise;
}

async function getPersistentCache(key) {
  const db = await openPersistentCache();
  if (!db) return null;
  return new Promise(resolve => {
    const request = db.transaction(PERSISTENT_CACHE_STORE, 'readonly')
      .objectStore(PERSISTENT_CACHE_STORE)
      .get(key);
    request.onsuccess = () => {
      const entry = request.result;
      if (!entry || Date.now() - entry.updatedAt > PERSISTENT_CACHE_MAX_AGE_MS) {
        resolve(null);
        return;
      }
      resolve(entry.value);
    };
    request.onerror = () => resolve(null);
  });
}

async function setPersistentCache(key, value) {
  const db = await openPersistentCache();
  if (!db) return;
  await new Promise(resolve => {
    const request = db.transaction(PERSISTENT_CACHE_STORE, 'readwrite')
      .objectStore(PERSISTENT_CACHE_STORE)
      .put({ key, value, updatedAt: Date.now() });
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
}

async function wcl(query, variables = {}) {
  const resp = await fetch(`${API_BASE_URL}/api/wcl`, {
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

document.getElementById('logUrl').addEventListener('input', function() {
  const nextCode = this.value.trim() ? safeExtractCode(this.value.trim()) : null;
  if (nextCode === loadedReportCode) return;
  fights = [];
  selectedFight = null;
  reportPhases = [];
  loadedReportCode = null;
  analysisCache.clear();
  mechanicEventCache.clear();
  document.getElementById('fight-picker').style.display = 'none';
  clearError('log-error');
});

function safeExtractCode(url) {
  try {
    return extractCode(url);
  } catch {
    return null;
  }
}

async function retrieveReport() {
  const url = document.getElementById('logUrl').value.trim();
  if (!url) { showError('log-error', 'Paste a WarcraftLogs report URL first.'); return; }
  clearError('log-error');
  document.getElementById('fight-picker').style.display = 'none';
  try {
    const code = extractCode(url);
    const cacheKey = `report:${code}:fights`;
    let report = await getPersistentCache(cacheKey);
    if (!report) {
      const data = await wcl(
        `query($code:String!){reportData{report(code:$code){phases{encounterID phases{id name isIntermission}} fights(killType:All){id name startTime endTime encounterID phaseTransitions{id startTime}}}}}`,
        { code }
      );
      report = data.reportData.report;
      await setPersistentCache(cacheKey, report);
    }
    fights = report.fights;
    reportPhases = report.phases || [];
    if (!fights.length) { showError('log-error', 'No fights found in this report.'); return; }
    const sel = document.getElementById('fightSelect');
    sel.innerHTML = fights.map(f =>
      `<option value="${f.id}">${f.name} (${fmtTime(f.endTime - f.startTime)})</option>`
    ).join('');
    selectedFight = fights[fights.length - 1];
    loadedReportCode = code;
    sel.value = selectedFight.id;
    document.getElementById('fightHint').textContent = `${fights.length} fight(s) retrieved - selected latest: ${selectedFight.name}`;
    document.getElementById('fight-picker').style.display = 'block';
  } catch(e) {
    showError('log-error', e.message);
  }
}

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

function setResultFilter(filter) {
  activeResultFilter = filter;
  if (lastRenderContext) {
    renderResults(
      lastRenderContext.results,
      lastRenderContext.fight,
      lastRenderContext.fightDur,
      lastRenderContext.tolerance,
      lastRenderContext.phaseNameMap,
      lastRenderContext.phaseStartMap
    );
  }
}

function setMechanicSummarySort(sort) {
  mechanicSummarySort = sort === 'hits' ? 'hits' : 'damage';
  if (lastMechanicRenderData) renderMidnightFallsResults(lastMechanicRenderData);
}

function resultMatchesFilter(result, filter) {
  if (filter === 'all') return true;
  if (filter === 'off') return result.status === 'late' || result.status === 'early';
  return result.status === filter;
}

function filterTitle(filter) {
  const titles = {
    all: 'All cooldowns',
    ok: 'On time',
    off: 'Off timing',
    missed: 'Missed'
  };
  return titles[filter] || titles.all;
}

function idSet(values) {
  return new Set(values.map(Number).filter(Number.isFinite));
}

function eventPlayerTargetId(ev, fightPlayerIds) {
  if (ev.targetID && (!fightPlayerIds.size || fightPlayerIds.has(ev.targetID))) return ev.targetID;
  if (ev.sourceID && fightPlayerIds.has(ev.sourceID)) return ev.sourceID;
  return ev.targetID || null;
}

function eventTime(ev, fightStart) {
  return ev.timestamp - fightStart;
}

function normalizeAbilityName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeClassName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z]+/g, '');
}

function playerNameHtml(entry) {
  const cls = normalizeClassName(entry.className);
  const classAttr = cls ? ` class="player-name class-${escHtml(cls)}"` : ' class="player-name"';
  return `<span${classAttr}>${escHtml(entry.player)}</span>`;
}

function abilityNameFor(ev, spellIdToName) {
  return spellIdToName[ev.abilityGameID] || ev.ability?.name || ev.ability || `ID:${ev.abilityGameID}`;
}

function eventAmount(ev) {
  const raw = ev.amount ?? ev.unmitigatedAmount ?? ev.hitPoints ?? 0;
  const amount = Number(raw);
  return Number.isFinite(amount) ? amount : 0;
}

async function fetchMidnightMetadata(code, fight) {
  const cacheKey = `${code}:${fight.id}:metadata`;
  if (mechanicEventCache.has(cacheKey)) return mechanicEventCache.get(cacheKey);
  const persistentKey = `mechanics:${cacheKey}`;
  const cached = await getPersistentCache(persistentKey);
  if (cached) {
    mechanicEventCache.set(cacheKey, cached);
    return cached;
  }
  const data = await wcl(
    `query($code:String!,$start:Float!,$end:Float!){
      reportData{report(code:$code){
        masterData{ actors{ id name type subType } abilities{ gameID name } }
        combatants: events(dataType:CombatantInfo,startTime:$start,endTime:$end,limit:10000){data}
        deaths: events(dataType:Deaths,startTime:$start,endTime:$end,limit:10000){data}
      }}
    }`,
    { code, start: fight.startTime, end: fight.endTime }
  );
  mechanicEventCache.set(cacheKey, data);
  await setPersistentCache(persistentKey, data);
  return data;
}

async function fetchDamagePage(code, start, end, damageType) {
  return wcl(
    `query($code:String!,$start:Float!,$end:Float!){
      reportData{report(code:$code){
        damage: events(dataType:${damageType},startTime:$start,endTime:$end,limit:10000){data nextPageTimestamp}
      }}
    }`,
    { code, start, end }
  );
}

async function fetchAllDamageEvents(code, fight, damageType = 'DamageTaken') {
  const cacheKey = `${code}:${fight.id}:damage:${damageType}`;
  if (mechanicEventCache.has(cacheKey)) return mechanicEventCache.get(cacheKey);
  const persistentKey = `mechanics:${cacheKey}`;
  const cached = await getPersistentCache(persistentKey);
  if (cached) {
    mechanicEventCache.set(cacheKey, cached);
    return cached;
  }
  const events = [];
  let start = fight.startTime;
  while (start < fight.endTime) {
    const data = await fetchDamagePage(code, start, fight.endTime, damageType);
    const page = data.reportData.report.damage;
    events.push(...(page?.data || []));
    if (!page?.nextPageTimestamp || page.nextPageTimestamp <= start) break;
    start = page.nextPageTimestamp;
  }
  mechanicEventCache.set(cacheKey, events);
  await setPersistentCache(persistentKey, events);
  return events;
}

function deathTimeByPlayer(deathEvents, fightStart) {
  const deaths = new Map();
  deathEvents.forEach(ev => {
    const playerId = ev.targetID || ev.sourceID || ev.actorID;
    const time = eventTime(ev, fightStart);
    if (!playerId || !Number.isFinite(time)) return;
    if (!deaths.has(playerId) || time < deaths.get(playerId)) deaths.set(playerId, time);
  });
  return deaths;
}

function nthDeathCutoffTime(deathEvents, fightStart, cutoff, fightPlayerIds) {
  if (!cutoff) return Infinity;
  const deaths = deathEvents
    .map(ev => ({
      playerId: ev.targetID || ev.sourceID || ev.actorID,
      time: eventTime(ev, fightStart)
    }))
    .filter(death => death.playerId && Number.isFinite(death.time) && (!fightPlayerIds.size || fightPlayerIds.has(death.playerId)))
    .sort((a, b) => a.time - b.time);
  return deaths.length >= cutoff ? deaths[cutoff - 1].time : Infinity;
}

function playerAliveAt(playerId, time, deathsByPlayer) {
  return !deathsByPlayer.has(playerId) || time < deathsByPlayer.get(playerId);
}

function groupGalvanizeEvents(events) {
  const groups = [];
  [...events].sort((a, b) => a.time - b.time).forEach(event => {
    const last = groups[groups.length - 1];
    if (last && Math.abs(event.time - last.time) <= MIDNIGHT_FALLS.galvanizeWindowMs) {
      last.events.push(event);
      last.time = Math.min(last.time, event.time);
    } else {
      groups.push({ time: event.time, events: [event] });
    }
  });
  return groups;
}

function aggregateDamage(events) {
  const byPlayerSpell = new Map();
  events.forEach(event => {
    const ability = event.summaryAbility || event.ability;
    const key = `${event.player}|${normalizeAbilityName(ability)}`;
    if (!byPlayerSpell.has(key)) {
      byPlayerSpell.set(key, {
        player: event.player,
        className: event.className,
        ability,
        hits: 0,
        damage: 0
      });
    }
    const row = byPlayerSpell.get(key);
    row.hits += event.hits || 1;
    row.damage += event.amount;
  });
  return [...byPlayerSpell.values()].sort((a, b) => b.damage - a.damage || b.hits - a.hits);
}

function groupByTimestampWindow(events, windowMs) {
  const groups = [];
  [...events].sort((a, b) => a.time - b.time).forEach(event => {
    const last = groups[groups.length - 1];
    if (last && Math.abs(event.time - last.time) <= windowMs) {
      last.events.push(event);
      last.time = Math.min(last.time, event.time);
    } else {
      groups.push({ time: event.time, events: [event] });
    }
  });
  return groups;
}

function filterSecondaryStarsplinterHits(events) {
  return events
    .filter(event => event.amount > MIDNIGHT_FALLS.starsplinterSplashMinDamage)
    .map(event => ({
      ...event,
      ability: `${event.ability} (splash)`,
      summaryAbility: `${event.ability} (splash)`
    }));
}

function groupRepeatedDamageHits(events) {
  const grouped = new Map();
  events.forEach(event => {
    const key = `${event.playerId}:${event.ability}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(event);
  });

  return [...grouped.values()].flatMap(playerEvents =>
    groupByTimestampWindow(playerEvents, MIDNIGHT_FALLS.groupedDamageWindowMs).map(group => {
      const first = group.events[0];
      const amount = group.events.reduce((sum, event) => sum + event.amount, 0);
      return {
        ...first,
        amount,
        hits: group.events.length,
        summaryAbility: first.ability,
        ability: group.events.length > 1 ? `${first.ability} x${group.events.length}` : first.ability
      };
    })
  );
}

async function analyzeMidnightFight(code, fight, deathCutoff) {
  const { phaseStartMap, phaseNameMap, phaseWindows, fightDur } = buildFightContext(fight);
  const meta = await fetchMidnightMetadata(code, fight);
  const report = meta.reportData.report;
  const actors = report.masterData?.actors || [];
  const actorMap = Object.fromEntries(actors.map(a => [a.id, a.name]));
  const classMap = Object.fromEntries(actors.map(a => [a.id, a.subType || a.type || '']));
  const abilities = report.masterData?.abilities || [];
  const spellIdToName = Object.fromEntries(abilities.map(a => [a.gameID, a.name]));
  const combatantEvents = report.combatants?.data || [];
  const fightPlayerIds = idSet(combatantEvents.map(e => e.sourceID).filter(Boolean));
  const deathEvents = report.deaths?.data || [];
  const deathsByPlayer = deathTimeByPlayer(deathEvents, fight.startTime);
  const cutoffTime = nthDeathCutoffTime(deathEvents, fight.startTime, deathCutoff, fightPlayerIds);

  let damageEvents;
  try {
    damageEvents = await fetchAllDamageEvents(code, fight, 'DamageTaken');
  } catch (e) {
    const message = String(e.message || '');
    if (!message.includes('DamageTaken') && !message.toLowerCase().includes('enum')) throw e;
    damageEvents = await fetchAllDamageEvents(code, fight, 'DamageDone');
  }

  const trackedNames = new Set(MIDNIGHT_FALLS.trackedDamage.map(normalizeAbilityName));
  const galvanizeName = normalizeAbilityName(MIDNIGHT_FALLS.galvanize);
  const midnightName = normalizeAbilityName(MIDNIGHT_FALLS.midnight);
  const starsplinterName = normalizeAbilityName(MIDNIGHT_FALLS.starsplinter);
  const groupedDamageNames = new Set(MIDNIGHT_FALLS.groupedDamage.map(normalizeAbilityName));
  const trackedDamage = [];
  const repeatedDamageHits = [];
  const galvanizeHits = [];
  const midnightHits = [];
  const starsplinterHits = [];

  damageEvents.forEach(ev => {
    const playerId = eventPlayerTargetId(ev, fightPlayerIds);
    if (!playerId || (fightPlayerIds.size && !fightPlayerIds.has(playerId))) return;
    const time = eventTime(ev, fight.startTime);
    if (!Number.isFinite(time)) return;
    if (time > cutoffTime) return;
    const ability = abilityNameFor(ev, spellIdToName);
    const normalized = normalizeAbilityName(ability);
    const event = {
      fightId: fight.id,
      fightName: fight.name,
      playerId,
      player: actorMap[playerId] || `Actor ${playerId}`,
      className: classMap[playerId] || '',
      ability,
      amount: eventAmount(ev),
      time,
      timestamp: fmtTime(time),
      phase: phaseAtTime(time, phaseWindows) || 1,
      phaseLabel: phaseTimeLabel(time, phaseWindows, phaseNameMap)
    };

    if (groupedDamageNames.has(normalized)) repeatedDamageHits.push(event);
    else if (trackedNames.has(normalized)) trackedDamage.push(event);
    if (normalized === starsplinterName) starsplinterHits.push(event);
    if (normalized === galvanizeName && event.phase === MIDNIGHT_FALLS.galvanizePhase) galvanizeHits.push(event);
    if (normalized === midnightName && event.phase === MIDNIGHT_FALLS.midnightPhase) midnightHits.push(event);
  });

  trackedDamage.push(...groupRepeatedDamageHits(repeatedDamageHits));
  trackedDamage.push(...filterSecondaryStarsplinterHits(starsplinterHits));

  const playerIds = [...fightPlayerIds];
  const galvanizeMisses = [];
  groupGalvanizeEvents(galvanizeHits).forEach((group, index) => {
    if (group.time > cutoffTime) return;
    const hitPlayerIds = new Set(group.events.map(event => event.playerId));
    playerIds.forEach(playerId => {
      if (!playerAliveAt(playerId, group.time, deathsByPlayer)) return;
      if (hitPlayerIds.has(playerId)) return;
      galvanizeMisses.push({
        fightId: fight.id,
        fightName: fight.name,
        playerId,
        player: actorMap[playerId] || `Actor ${playerId}`,
        className: classMap[playerId] || '',
        ability: MIDNIGHT_FALLS.galvanize,
        amount: 0,
        time: group.time,
        timestamp: fmtTime(group.time),
        phase: phaseAtTime(group.time, phaseWindows) || 1,
        phaseLabel: phaseTimeLabel(group.time, phaseWindows, phaseNameMap),
        occurrence: index + 1
      });
    });
  });

  return {
    fight,
    fightDur,
    phaseNameMap,
    phaseStartMap,
    phaseWindows,
    trackedDamage,
    galvanizeHits,
    galvanizeMisses,
    midnightHits,
    deathCutoff,
    cutoffTime
  };
}

function mergeMidnightAnalyses(analyses) {
  const base = analyses[0];
  return {
    ...base,
    fight: { ...base.fight, name: `${base.fight.name} (${analyses.length} pulls)` },
    fightDur: analyses.reduce((sum, result) => sum + result.fightDur, 0),
    trackedDamage: analyses.flatMap(result => result.trackedDamage),
    galvanizeHits: analyses.flatMap(result => result.galvanizeHits),
    galvanizeMisses: analyses.flatMap(result => result.galvanizeMisses),
    midnightHits: analyses.flatMap(result => result.midnightHits),
    aggregateCount: analyses.length
  };
}

async function runMechanicCheck() {
  await runMechanicAnalysis(false);
}

async function runAggregateMechanicCheck() {
  await runMechanicAnalysis(true);
}

async function runMechanicAnalysis(aggregate) {
  const main = document.getElementById('mainArea');
  main.innerHTML = `<div class="loading"><div class="spinner"></div> Fetching Midnight Falls events${aggregate ? ' for matching fights' : ''}…</div>`;

  try {
    const url = document.getElementById('logUrl').value.trim();
    if (!url) throw new Error('Paste a WarcraftLogs report URL first.');
    const code = extractCode(url);
    if (!selectedFight || loadedReportCode !== code) {
      throw new Error('Click Retrieve to load fights for this report before analyzing.');
    }

    if (normalizeAbilityName(selectedFight.name) !== normalizeAbilityName(MIDNIGHT_FALLS.fightName)) {
      throw new Error(`No hardcoded mechanic analyzer exists for ${selectedFight.name}. Select a Midnight Falls pull.`);
    }

    const deathCutoff = Math.max(0, parseInt(document.getElementById('mechanicDeathCutoff')?.value, 10) || 0);
    const targetFights = aggregate
      ? fights.filter(fight => normalizeAbilityName(fight.name) === normalizeAbilityName(selectedFight.name))
      : [selectedFight];
    const analyses = [];
    for (const fight of targetFights) {
      analyses.push(await analyzeMidnightFight(code, fight, deathCutoff));
    }
    const result = aggregate ? mergeMidnightAnalyses(analyses) : analyses[0];
    renderMidnightFallsResults({
      ...result,
      damageSummary: aggregateDamage([...result.trackedDamage, ...result.midnightHits])
    });
  } catch(e) {
    document.getElementById('mainArea').innerHTML = `<div class="error-box">⚠ ${escHtml(e.message)}</div>`;
  }
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
    if (!selectedFight || loadedReportCode !== code) {
      throw new Error('Click Retrieve to load fights for this report before analyzing.');
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

    activeResultFilter = 'all';
    renderResults(results, fight, fightDur, tolerance, phaseNameMap, phaseStartMap);
  } catch(e) {
    document.getElementById('mainArea').innerHTML = `<div class="error-box">⚠ ${escHtml(e.message)}</div>`;
  }
}

// ─── Render results ─────────────────────────────────────────────────────────

function renderResults(results, fight, fightDur, tolerance, phaseNameMap = {}, phaseStartMap = {}) {
  lastRenderContext = { results, fight, fightDur, tolerance, phaseNameMap, phaseStartMap };

  const counts = { ok: 0, late: 0, early: 0, missed: 0 };
  results.forEach(r => counts[r.status]++);
  const visibleResults = results.filter(r => resultMatchesFilter(r, activeResultFilter));

  const pct = val => Math.min(100, Math.max(0, (val / fightDur) * 100)).toFixed(2);

  const badges = { ok: 'badge-ok', late: 'badge-late', early: 'badge-early', missed: 'badge-missed' };
  const labels = {
    ok: r => 'On time',
    late: r => `+${Math.round(r.delta / 1000)}s late`,
    early: r => `${Math.round(r.delta / 1000)}s early`,
    missed: r => 'Missed'
  };

  const phaseLabelFor = r => {
    const ph = r.assign.phase;
    return ph !== undefined
      ? (phaseNameMap[ph]?.name || 'P' + ph) + ' +' + r.assign.time + 's'
      : String(r.assign.time);
  };
  const spellLabelFor = r => r.spellName || r.assign.spell || (r.assign.spellId ? 'ID:' + r.assign.spellId : '—');
  const statActive = filter => activeResultFilter === filter ? ' active' : '';

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
  visibleResults.forEach(r => {
    const ph = r.assign.phase;
    if (ph !== undefined && ph !== lastPhase) {
      lastPhase = ph;
      const pi = phaseNameMap[ph];
      const phaseName = pi ? pi.name : `Phase ${ph}`;
      const phaseTime = phaseStartMap[ph];
      const timeLabel = phaseTime !== undefined ? `<span class="phase-time">${fmtTime(phaseTime)}</span>` : '';
      rows += `<div class="phase-divider${pi?.intermission ? ' intermission' : ''}">${escHtml(phaseName)}${timeLabel}</div>`;
    }
    const phaseLabel = escHtml(phaseLabelFor(r));
    const winL = pct(r.assignedMs - tolerance);
    const winW = pct(Math.min(r.assignedMs + tolerance, fightDur) - Math.max(r.assignedMs - tolerance, 0));
    rows += `
      <div class="result-item">
        <div class="result-row">
          <span style="color:var(--muted)">${phaseLabel}</span>
          <span>${escHtml(r.assign.player)}</span>
          <span>${escHtml(spellLabelFor(r))}</span>
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
  if (!rows) {
    rows = `<div class="result-empty">No ${escHtml(filterTitle(activeResultFilter).toLowerCase())} results.</div>`;
  }

  const focusedRows = visibleResults.map(r => `
    <div class="filtered-row">
      <span>${escHtml(r.assign.player)}</span>
      <span>${escHtml(spellLabelFor(r))}</span>
      <span>${escHtml(phaseLabelFor(r))}</span>
      <span>${r.actual ? fmtTime(r.actual.time) : '—'}</span>
      <span><span class="badge ${badges[r.status]}">${labels[r.status](r)}</span></span>
    </div>
  `).join('');
  const focusedPanel = activeResultFilter === 'all' ? '' : `
    <div class="filtered-panel">
      <div class="filtered-head">
        <div>
          <h2>${escHtml(filterTitle(activeResultFilter))}</h2>
          <p>${visibleResults.length} of ${results.length} cooldown assignment(s)</p>
        </div>
        <button class="btn btn-sm" onclick="setResultFilter('all')">Clear</button>
      </div>
      <div class="filtered-list">
        <div class="filtered-header">
          <span>Player</span><span>Spell</span><span>Assigned</span><span>Actual</span><span>Status</span>
        </div>
        ${focusedRows || `<div class="result-empty">No ${escHtml(filterTitle(activeResultFilter).toLowerCase())} results.</div>`}
      </div>
    </div>`;

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
      <button type="button" class="stat stat-ok${statActive('ok')}" onclick="setResultFilter('ok')" aria-pressed="${activeResultFilter === 'ok'}"><div class="stat-num">${counts.ok}</div><div class="stat-lbl">On time</div></button>
      <button type="button" class="stat stat-late${statActive('off')}" onclick="setResultFilter('off')" aria-pressed="${activeResultFilter === 'off'}"><div class="stat-num">${counts.late + counts.early}</div><div class="stat-lbl">Off timing</div></button>
      <button type="button" class="stat stat-missed${statActive('missed')}" onclick="setResultFilter('missed')" aria-pressed="${activeResultFilter === 'missed'}"><div class="stat-num">${counts.missed}</div><div class="stat-lbl">Missed</div></button>
      <button type="button" class="stat${statActive('all')}" onclick="setResultFilter('all')" aria-pressed="${activeResultFilter === 'all'}"><div class="stat-num">${results.length}</div><div class="stat-lbl">Total</div></button>
    </div>
    ${focusedPanel}
    <div class="results-table-wrap">
      <div class="results-header">
        <span>Assigned</span><span>Player</span><span>Spell</span><span>Actual</span><span>Status</span>
      </div>
      ${rows}
    </div>`;
}

function renderMidnightFallsResults(data) {
  lastMechanicRenderData = data;
  const {
    fight,
    fightDur,
    phaseNameMap,
    phaseStartMap,
    phaseWindows,
    trackedDamage,
    galvanizeHits,
    galvanizeMisses,
    midnightHits,
    deathCutoff,
    cutoffTime,
    damageSummary,
    aggregateCount
  } = data;
  const isAggregate = aggregateCount > 1;
  const allDamage = [...trackedDamage, ...midnightHits];
  const totalDamage = allDamage.reduce((sum, event) => sum + event.amount, 0);
  const phases = Object.keys(phaseStartMap).map(Number).sort((a, b) => phaseStartMap[a] - phaseStartMap[b]);
  const cutoffLabel = deathCutoff
    ? (isAggregate
      ? `Ignoring events after death ${deathCutoff} separately for each pull.`
      : `Ignoring events after death ${deathCutoff}${Number.isFinite(cutoffTime) ? ` at ${fmtTime(cutoffTime)}` : ''}.`)
    : 'No death cutoff applied.';

  const damageRowsFor = events => events
    .sort((a, b) => a.time - b.time || a.player.localeCompare(b.player))
    .map(event => `
      <div class="mechanic-row${isAggregate ? ' is-aggregate' : ''}">
        ${isAggregate ? `<span>#${escHtml(String(event.fightId))}</span>` : ''}
        <span>${escHtml(event.timestamp)}</span>
        <span>${playerNameHtml(event)}</span>
        <span>${escHtml(event.ability)}</span>
        <span>${event.amount.toLocaleString()}</span>
        <span>${escHtml(event.phaseLabel)}</span>
      </div>
    `).join('');

  const phaseSections = phases.map(phase => {
    const phaseTrackedDamage = trackedDamage.filter(event => event.phase === phase);
    const phaseMidnightHits = midnightHits.filter(event => event.phase === phase);
    const phaseGalvanizeMisses = galvanizeMisses.filter(event => event.phase === phase);
    const phaseName = phaseNameMap[phase]?.name || `Phase ${phase}`;
    const phaseStart = phaseWindows[phase]?.start ?? phaseStartMap[phase] ?? 0;
    return `
      <div class="phase-divider${phaseNameMap[phase]?.intermission ? ' intermission' : ''}">
        ${escHtml(phaseName)}<span class="phase-time">${fmtTime(phaseStart)}</span>
      </div>
      <div class="mechanic-subhead">Listed Damage Taken</div>
      ${damageRowsFor(phaseTrackedDamage) || '<div class="result-empty">No listed damage in this phase.</div>'}
      ${phase === MIDNIGHT_FALLS.midnightPhase ? `
        <div class="mechanic-subhead">Midnight Avoidable Hits</div>
        ${damageRowsFor(phaseMidnightHits) || '<div class="result-empty">No Midnight hits in this phase.</div>'}
      ` : ''}
      ${phase === MIDNIGHT_FALLS.galvanizePhase ? `
        <div class="mechanic-subhead">Galvanize Misses</div>
        ${phaseGalvanizeMisses.map(event => `
        <div class="mechanic-row${isAggregate ? ' is-aggregate' : ''}">
          ${isAggregate ? `<span>#${escHtml(String(event.fightId))}</span>` : ''}
          <span>${escHtml(event.timestamp)}</span>
          <span>${playerNameHtml(event)}</span>
          <span>${escHtml(event.ability)} #${event.occurrence}</span>
          <span>Missed soak</span>
          <span>${escHtml(event.phaseLabel)}</span>
        </div>
        `).join('') || '<div class="result-empty">No Galvanize soak misses in this phase.</div>'}
      ` : ''}
    `;
  }).join('');

  const sortedSummary = [...damageSummary].sort((a, b) =>
    mechanicSummarySort === 'hits'
      ? b.hits - a.hits || b.damage - a.damage || a.player.localeCompare(b.player)
      : b.damage - a.damage || b.hits - a.hits || a.player.localeCompare(b.player)
  );
  const summaryByAbility = sortedSummary.reduce((groups, row) => {
    if (!groups.has(row.ability)) groups.set(row.ability, []);
    groups.get(row.ability).push(row);
    return groups;
  }, new Map());
  const summarySortButtons = `
    <div class="mechanic-sort">
      <button type="button" class="sort-btn${mechanicSummarySort === 'damage' ? ' active' : ''}" onclick="setMechanicSummarySort('damage')" aria-pressed="${mechanicSummarySort === 'damage'}">Damage</button>
      <button type="button" class="sort-btn${mechanicSummarySort === 'hits' ? ' active' : ''}" onclick="setMechanicSummarySort('hits')" aria-pressed="${mechanicSummarySort === 'hits'}">Hits</button>
    </div>
  `;
  const summarySections = [...summaryByAbility.entries()].map(([ability, rows]) => {
    const hits = rows.reduce((sum, row) => sum + row.hits, 0);
    const damage = rows.reduce((sum, row) => sum + row.damage, 0);
    const rowHtml = rows.map(row => `
      <div class="mechanic-summary-row">
        <span>${playerNameHtml(row)}</span>
        <strong>${row.hits}</strong>
        <strong>${row.damage.toLocaleString()}</strong>
      </div>
    `).join('');
    return `
      <div class="mechanic-summary-section">
        <div class="mechanic-summary-title">
          <span>${escHtml(ability)}</span>
          <span>${hits} hit${hits === 1 ? '' : 's'} · ${damage.toLocaleString()}</span>
        </div>
        <div class="mechanic-summary-header">
          <span>Player</span><span>Hits</span><span>Damage</span>
        </div>
        ${rowHtml}
      </div>
    `;
  }).join('');

  const maxPhaseId = Math.max(...Object.keys(phaseStartMap).map(Number));
  const lastPhaseName = phaseNameMap[maxPhaseId]?.name;
  const phaseReachedLabel = lastPhaseName && maxPhaseId > 1
    ? `<span class="dur">→ ${escHtml(lastPhaseName)}</span>` : '';

  document.getElementById('mainArea').innerHTML = `
    <div class="fight-title">
      ${escHtml(fight.name)}
      <span class="dur">${isAggregate ? `${aggregateCount} pulls` : fmtTime(fight.endTime - fight.startTime)}</span>
      ${phaseReachedLabel}
    </div>
    <div class="summary-grid">
      <div class="stat stat-missed"><div class="stat-num">${allDamage.length}</div><div class="stat-lbl">Tracked hits</div></div>
      <div class="stat stat-missed"><div class="stat-num">${galvanizeMisses.length}</div><div class="stat-lbl">Galvanize misses</div></div>
      <div class="stat stat-missed"><div class="stat-num">${midnightHits.length}</div><div class="stat-lbl">Midnight hits</div></div>
      <div class="stat"><div class="stat-num">${totalDamage.toLocaleString()}</div><div class="stat-lbl">Damage</div></div>
    </div>
    <div class="summary-grid mechanic-rule-grid">
      <div class="stat"><div class="stat-num">${trackedDamage.length}</div><div class="stat-lbl">Glaives / Quasar / Starsplinter / Swarm / Darkwell</div></div>
      <div class="stat"><div class="stat-num">${galvanizeHits.length}</div><div class="stat-lbl">Galvanize hits</div></div>
      <div class="stat"><div class="stat-num">${fmtTime(fightDur)}</div><div class="stat-lbl">Duration</div></div>
      <div class="stat"><div class="stat-num">${phases.length}</div><div class="stat-lbl">Phases</div></div>
    </div>
    <div class="mechanic-layout">
      <div class="results-table-wrap">
        <div class="mechanic-head">
          <h2>Midnight Falls Mechanics</h2>
          <p>Damage taken, missed Galvanize soaks, and Midnight avoidable hits grouped by phase. ${escHtml(cutoffLabel)}</p>
        </div>
        <div class="mechanic-header${isAggregate ? ' is-aggregate' : ''}">
          ${isAggregate ? '<span>Pull</span>' : ''}
          <span>Time</span><span>Player</span><span>Ability</span><span>Damage</span><span>Phase</span>
        </div>
        ${phaseSections || '<div class="result-empty">No Midnight Falls mechanic data found.</div>'}
      </div>
      <div class="results-table-wrap">
        <div class="mechanic-head">
          <h2>Damage Summary</h2>
          <p>Hits and damage by player, split by ability</p>
          ${summarySortButtons}
        </div>
        ${summarySections || '<div class="result-empty">No tracked damage.</div>'}
      </div>
    </div>`;
}
