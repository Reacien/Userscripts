// ==UserScript==
// @name         SMMO Travel Companion
// @namespace    https://reacien.dev/
// @version      0.31.0
// @description  Walking stats, level progress, cooldowns, chat and page popups, character info and market watch for SimpleMMO. It never clicks or acts in the game for you.
// @author       Reacien
// @icon         https://play-lh.googleusercontent.com/2HpPmq4Mikjkk-E30oLLZ6irM0vQZokuy0h00plEvlFsXMypfm7jZ0ysdcO--z3BnRk8_ZXVTt16UpsfaMJBIw
// @match        https://web.simple-mmo.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// @homepageURL  https://github.com/Reacien/Userscripts/tree/main/SimpleMMO
// @supportURL   https://github.com/Reacien/Userscripts/issues
// @updateURL    https://raw.githubusercontent.com/Reacien/Userscripts/main/SimpleMMO/smmo-travel-companion.user.js
// @downloadURL  https://raw.githubusercontent.com/Reacien/Userscripts/main/SimpleMMO/smmo-travel-companion.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ===========================================================================
  // 1. Storage and settings
  // ===========================================================================
  const KEY = {
    settings: 'stc_settings',
    session: 'stc_session',
    lifetime: 'stc_lifetime',
    expWindow: 'stc_expwin',
    history: 'stc_history',
    timers: 'stc_timers',
    data: 'stc_data',
    alerted: 'stc_alerted',
    seen: 'stc_seen',
    bg: 'stc_bg',
    api: 'stc_api',
    apiCalls: 'stc_api_calls',
    dock: 'stc_dock',
    collection: 'stc_collection',
    allowGive: 'stc_allow_give',
    leader: 'stc_leader'
  };

  const DEFAULT_SETTINGS = {
    // Cues
    soundOn: true,
    volume: 0.3,
    titleCue: true,
    desktopNotify: false,
    warnMinutes: 0,
    verifyAlert: true,
    // Walking
    idleResetMinutes: 30,
    // Data sources
    backgroundChecks: true,
    bgRefreshMinutes: 15,
    apiKey: '',
    apiRefreshSeconds: 60,
    // On the website
    showSidebar: true,
    hiddenRows: [],      // rows of the Companion block you chose to hide
    showTravelStrip: true,
    showPageCards: true,
    walkDetailsOpen: false,
    timeMode: 'clock',   // cooldowns show the local time they're ready; click to switch to countdowns
    planTarget: '',
    planTime: '',
    questSort: 'game',   // 'game' = the game's own order, 'left' = fewest left first
    collectionMarks: true,
    sideFolded: false,
    guardGiving: true,
    chatPopup: true,
    pagePopups: true,
    popupsOnlyOnTravel: false,
    messageAlert: true,
    notificationsPopup: true,
    shortcut: true,
    // Market
    energyTarget: 0,  // alert when energy reaches this many points (0 = full)
    qpTarget: 0,      // same for quest points
    marketWatch: false,
    marketMaxPrice: 0,
    marketRefreshMinutes: 5,
    // Panel
    alerts: {
      energy: true, qp: true, job: true, crafting: true, sprint: false,
      worshipBuff: true, worship: false, tasks: true, boss: true, safeMode: false,
      orphanage3: true
    }
  };

  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return clone(fallback);
      const saved = JSON.parse(raw);
      if (Array.isArray(fallback)) return Array.isArray(saved) ? saved : clone(fallback);
      const merged = Object.assign({}, fallback, saved);
      if (fallback.alerts) merged.alerts = Object.assign({}, fallback.alerts, saved.alerts);
      return merged;
    } catch (e) {
      return clone(fallback);
    }
  }

  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full or blocked */ }
  }

  // Read-modify-write in one go, so tabs don't overwrite each other.
  function update(key, fn, fallback) {
    const value = load(key, fallback || {});
    fn(value);
    save(key, value);
    return value;
  }

  // A session starts at your first step, and runs until you end it or stop playing for a while.
  function newSession(startAt) {
    return { active: true, startedAt: startAt, lastStepAt: 0, lastActivityAt: startAt, steps: 0, gold: 0, exp: 0,
      loot: {}, lootLog: [], enemiesMet: 0, fought: 0, foughtIds: [] };
  }

  // No session running yet: the next step starts one.
  function emptySession() {
    return { active: false, steps: 0, gold: 0, exp: 0, loot: {}, lootLog: [], enemiesMet: 0, fought: 0, foughtIds: [] };
  }

  function loadSession() {
    const saved = load(KEY.session, {});
    // Sessions saved by older versions: running if they had steps.
    if (saved.active === undefined) {
      saved.active = saved.steps > 0;
      saved.lastActivityAt = saved.lastStepAt || saved.startedAt;
    }
    return Object.assign(emptySession(), saved);
  }

  let settings = load(KEY.settings, DEFAULT_SETTINGS);
  if (settings.popupVersion !== 2) {
    // Popups now cover every page, from any page (it used to be a list, only on Travel).
    settings.popupsOnlyOnTravel = false;
    settings.pagePopups = true;
    settings.popupVersion = 2;
    save(KEY.settings, settings);
  }
  let session = loadSession();

  // Some of the game's own links (like the Travel button) add "?new_page=true" to the address.
  // Remove it, so the address stays the page you're on. This only changes what the address bar
  // shows; the page itself isn't reloaded.
  function withoutNewPage(url) {
    const u = new URL(url, location.origin);
    u.searchParams.delete('new_page');
    return u.pathname + (u.search === '?' ? '' : u.search) + u.hash;
  }

  if (new URLSearchParams(location.search).has('new_page')) {
    history.replaceState(history.state, '', withoutNewPage(location.href));
  }

  const TAB_ID = Math.random().toString(36).slice(2);
  const PATH = location.pathname;
  const isTravelPage = PATH.startsWith('/travel');

  // ===========================================================================
  // 2. Helpers
  // ===========================================================================
  const MIN = 60000;
  const REGEN_MS = 5 * MIN; // EP and QP: +1 at every 5-minute mark on the clock (from the game's own code)
  const RARITIES = ['common', 'uncommon', 'rare', 'elite', 'epic', 'legendary', 'celestial', 'exotic'];
  const RARITY_COLORS = {
    common: '#d1d5db', uncommon: '#4ade80', rare: '#60a5fa', elite: '#f87171',
    epic: '#c084fc', legendary: '#facc15', celestial: '#22d3ee', exotic: '#fb923c'
  };

  function nextRegenTick(time) {
    return Math.floor(time / REGEN_MS) * REGEN_MS + REGEN_MS;
  }

  const UNIT_MS = { d: 86400000, h: 3600000, m: 60000, s: 1000 };

  // "01h 24m 53s", "2 hours, 38 minutes, and 22 seconds", "04:48", "02:16:33" -> milliseconds
  function parseDuration(text) {
    if (!text) return null;
    const colon = text.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
    if (colon) {
      const a = parseInt(colon[1], 10), b = parseInt(colon[2], 10);
      return colon[3] !== undefined ? (a * 3600 + b * 60 + parseInt(colon[3], 10)) * 1000 : (a * 60 + b) * 1000;
    }
    const unitRe = /(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi;
    let total = 0, found = false, lastEnd = 0, match;
    while ((match = unitRe.exec(text)) !== null) {
      if (found && !/^[\s,]*(and)?\s*$/i.test(text.slice(lastEnd, match.index))) break;
      total += parseInt(match[1], 10) * UNIT_MS[match[2][0].toLowerCase()];
      found = true;
      lastEnd = match.index + match[0].length;
    }
    return found ? total : null;
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? h + ':' + m + ':' + s : m + ':' + s;
  }

  function timeAgo(time) {
    const s = Math.floor((Date.now() - time) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  const fmt = (n) => Math.round(n).toLocaleString();

  // 12,345,678 -> "12.3M"
  function short(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e4) return (n / 1e3).toFixed(0) + 'K';
    return fmt(n);
  }

  function toNumber(value) {
    if (typeof value === 'number') return value;
    if (typeof value !== 'string') return 0;
    const digits = value.replace(/[^0-9]/g, '');
    return digits ? parseInt(digits, 10) : 0;
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function isTyping() {
    const el = document.activeElement;
    return el && (/^(input|textarea|select)$/i.test(el.tagName) || el.isContentEditable);
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }

  function rarityOf(el) {
    for (const r of RARITIES) if (el.classList.contains(r + '-item')) return r;
    return null;
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // The player id appears in the sidebar's Collections link: /collection/258069/avatars
  function playerId() {
    const data = load(KEY.data, {});
    if (data.player && data.player.id) return data.player.id;
    const a = document.querySelector('a[href*="/collection/"]');
    const m = a && a.getAttribute('href').match(/\/collection\/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  // ===========================================================================
  // 3. Only one tab does background work
  // ===========================================================================
  function isLeader() {
    const now = Date.now();
    const lock = load(KEY.leader, {});
    if (!lock.id || lock.until < now || lock.id === TAB_ID) {
      save(KEY.leader, { id: TAB_ID, until: now + 15000 });
      return true;
    }
    return false;
  }

  // Hand over right away when you leave the page, so the next page can take over without waiting.
  window.addEventListener('pagehide', function () {
    if (load(KEY.leader, {}).id === TAB_ID) save(KEY.leader, {});
  });

  // ===========================================================================
  // 4. Reading game data from page HTML (background and current page)
  // ===========================================================================
  // Every game page includes its data as: game_data.push({ "temple.daily_reset_in": 8533346, ... })
  function readGameData(html) {
    const data = {};
    const re = /game_data\.push\((\{[\s\S]*?\})\)\s*[;\n]/g;
    let match;
    while ((match = re.exec(html)) !== null) {
      try { Object.assign(data, JSON.parse(match[1])); } catch (e) { /* skip broken block */ }
    }
    return data;
  }

  function setTimer(id, values) {
    update(KEY.timers, (t) => { t[id] = Object.assign({}, values, { seenAt: Date.now() }); });
  }

  // When a timer runs out, read its page again this soon after, to pick up the new state.
  const RECHECK_AFTER_END = 3000;

  // Each source reads one page and returns when it should be checked again (or null).
  const SOURCES = {
    '/home': function (html) {
      const d = readGameData(html);
      const left = d['profession.duration.remaining_wait_length'];
      if (typeof left === 'number' && left > 0) {
        setTimer('job', {
          working: true,
          endsAt: Date.now() + left,
          unitMs: d['profession.duration.wait_length'] || 0,
          finalAmount: d['profession.final_amount'] || 0,
          rewardGold: d['profession.rewards.gold'] || 0,
          rewardExp: d['profession.rewards.player_experience'] || 0,
          rewardSkillExp: d['profession.rewards.profession_experience'] || 0
        });
        return Date.now() + left + RECHECK_AFTER_END;
      }
      setTimer('job', { working: false, endsAt: null });
      return null;
    },

    '/profession': function (html) {
      const d = readGameData(html);
      const left = d['profession.work.remaining_time'];
      if (typeof left === 'number' && left > 0) {
        setTimer('job', {
          working: true,
          endsAt: Date.now() + left,
          finalAmount: d['profession.final_amount'] || 0,
          rewardGold: d['profession.rewards.gold'] || 0,
          rewardExp: d['profession.rewards.player_experience'] || 0,
          rewardSkillExp: d['profession.rewards.profession_experience'] || 0
        });
        return Date.now() + left + RECHECK_AFTER_END;
      }
      if ('profession.duration.wait_length' in d) setTimer('job', { working: false, endsAt: null });
      return null;
    },

    '/temple': function (html) {
      const d = readGameData(html);
      const now = Date.now();
      let recheck = null;
      if (typeof d['temple.daily_reset_in'] === 'number') {
        const reset = now + d['temple.daily_reset_in'];
        setTimer('worship', { endsAt: reset });
        recheck = reset + RECHECK_AFTER_END;
      }
      if (typeof d['temple.worship_count'] === 'number') {
        setTimer('worshipUse', { available: d['temple.worship_count'] < (d['temple.worship_limit'] || 1) });
      }
      const buff = d['temple.worship_ends_in'];
      if (typeof buff === 'number' && buff > 0) {
        setTimer('worshipBuff', { active: true, endsAt: now + buff });
        recheck = Math.min(recheck || Infinity, now + buff + RECHECK_AFTER_END);
      } else if ('temple.worship_ends_in' in d) {
        setTimer('worshipBuff', { active: false, endsAt: null });
      }
      return recheck;
    },

    '/tasks/viewall': function (html) {
      const m = html.match(/let countdown\s*=\s*(\d{9,11})/);
      if (!m) return null;
      let reset = parseInt(m[1], 10) * 1000;
      while (reset < Date.now()) reset += 86400000;
      setTimer('tasks', { endsAt: reset });
      return reset + RECHECK_AFTER_END;
    },

    '/orphanage': function (html) {
      const d = readGameData(html);
      if ('orphanage.has_redeemed_daily_buff' in d) {
        setTimer('orphanageBuff', { available: !d['orphanage.has_redeemed_daily_buff'] });
      }
      if (Array.isArray(d['orphanage.tiers'])) saveOrphanage(d['orphanage.tiers']);
      const tasks = load(KEY.timers, {}).tasks; // daily reset
      return tasks && tasks.endsAt ? tasks.endsAt + RECHECK_AFTER_END : null;
    },

    '/battle': function (html) {
      const d = readGameData(html);
      const boss = d['battle.world_boss.next'];
      if (boss && typeof boss.available_in === 'number') {
        const endsAt = Date.now() + boss.available_in;
        setTimer('boss', {
          endsAt: endsAt, name: boss.name, level: boss.level,
          hp: boss.current_health, maxHp: boss.max_health, fromApi: false
        });
        return endsAt + RECHECK_AFTER_END;
      }
      // The page says there's no world boss coming up: forget the last one.
      if ('battle.world_boss.next' in d) setTimer('boss', { none: true, endsAt: null, fromApi: false });
      return null;
    },

    '/crafting/menu': function (html) {
      if (/not currently crafting/i.test(html)) {
        setTimer('crafting', { active: false, endsAt: null });
      } else {
        const old = load(KEY.timers, {}).crafting;
        setTimer('crafting', { active: true, endsAt: old && old.active ? old.endsAt : null });
      }
      return null;
    }
  };

  function scheduleSource(path, recheckAt) {
    const fallback = Date.now() + Math.max(2, settings.bgRefreshMinutes) * MIN;
    update(KEY.bg, (bg) => {
      bg[path] = { nextAt: recheckAt ? Math.min(recheckAt, fallback) : fallback, checkedAt: Date.now() };
    });
  }

  let bgBusy = false;
  let bgNotBefore = 0;

  async function backgroundTick() {
    if (!settings.backgroundChecks || bgBusy || Date.now() < bgNotBefore || !isLeader()) return;
    const bg = load(KEY.bg, {});
    const due = Object.keys(SOURCES).find((p) => p !== PATH && (!bg[p] || bg[p].nextAt <= Date.now()));
    if (!due) return;

    bgBusy = true;
    try {
      const response = await fetch(due, { credentials: 'same-origin' });
      if (!response.ok || /\/login/.test(response.url)) throw new Error('not available');
      scheduleSource(due, SOURCES[due](await response.text()));
    } catch (e) {
      update(KEY.bg, (b) => { b[due] = { nextAt: Date.now() + 5 * MIN, checkedAt: Date.now(), error: true }; });
    }
    bgBusy = false;
    bgNotBefore = Date.now() + 3000 + Math.random() * 5000; // spread requests out
  }

  // ===========================================================================
  // 5. Official Public API (optional, needs your own key)
  // ===========================================================================
  // The limit is 40 requests a minute. We keep ourselves to 20 across all tabs.
  const API = 'https://api.simple-mmo.com';
  const API_BUDGET = 30;

  function takeApiBudget() {
    const now = Date.now();
    let ok = false;
    update(KEY.apiCalls, (calls) => {
      const recent = calls.filter((t) => now - t < MIN);
      calls.length = 0;
      recent.forEach((t) => calls.push(t));
      if (calls.length < API_BUDGET) { calls.push(now); ok = true; }
    }, []);
    return ok;
  }

  async function apiPost(path) {
    if (!settings.apiKey) return { status: 0, data: null };
    if (!takeApiBudget()) return { status: 'budget', data: null };
    const response = await fetch(API + path, { method: 'POST', body: new URLSearchParams({ api_key: settings.apiKey }) });
    if (response.status === 401 || response.status === 403) {
      update(KEY.api, (a) => { a.keyRejected = true; a.message = 'Key rejected'; });
    } else if (response.status === 429) {
      update(KEY.api, (a) => { a.pausedUntil = Date.now() + 5 * MIN; a.message = 'Rate limited, waiting 5 min'; });
    }
    // The game says how many requests are left this minute. Back off before reaching the limit.
    const remaining = parseInt(response.headers.get('X-RateLimit-Remaining'), 10);
    if (remaining >= 0 && remaining < 5) {
      update(KEY.api, (a) => { a.pausedUntil = Date.now() + MIN; a.message = 'Near the limit, pausing 1 min'; });
    }
    return { status: response.status, data: response.ok ? await response.json() : null };
  }

  // Regular API checks. Each runs on its own schedule; one request per tick at most.
  const API_JOBS = [
    { id: 'me', every: () => Math.max(5, settings.apiRefreshSeconds) * 1000, path: () => '/v2/player/me', save: savePlayer },
    { id: 'bosses', every: () => 10 * MIN, path: () => '/v1/worldboss/all', save: saveBosses },
    { id: 'skills', every: () => 10 * MIN, path: () => (playerId() ? '/v1/player/skills/' + playerId() : null), save: saveSkills },
    { id: 'orphanage', every: () => 10 * MIN, path: () => '/v2/orphanage', save: saveOrphanage },
    { id: 'market', every: () => Math.max(2, settings.marketRefreshMinutes) * MIN, path: () => (settings.marketWatch ? '/v1/diamond-market' : null), save: saveMarket }
  ];

  let apiBusy = false;

  async function apiTick() {
    const state = load(KEY.api, {});
    if (!settings.apiKey || apiBusy || state.keyRejected || Date.now() < (state.pausedUntil || 0) || !isLeader()) return;

    const jobs = state.jobs || {};
    const job = API_JOBS.find((j) => j.path() && (!jobs[j.id] || jobs[j.id].nextAt <= Date.now()));
    if (!job) return;

    apiBusy = true;
    let nextAt;
    try {
      const result = await apiPost(job.path());
      if (result.data) {
        job.save(result.data);
        nextAt = Date.now() + job.every();
        update(KEY.api, (a) => { a.okAt = Date.now(); a.message = 'Connected'; });
      } else if (result.status === 'budget') {
        nextAt = Date.now() + 20000;
      } else {
        throw new Error('HTTP ' + result.status);
      }
      update(KEY.api, (a) => { a.jobs = a.jobs || {}; a.jobs[job.id] = { nextAt: nextAt, failures: 0 }; });
    } catch (e) {
      update(KEY.api, (a) => {
        a.jobs = a.jobs || {};
        const failures = ((a.jobs[job.id] || {}).failures || 0) + 1;
        a.jobs[job.id] = { nextAt: Date.now() + Math.min(30 * MIN, Math.pow(2, failures) * MIN), failures: failures };
        if (!a.keyRejected && !a.pausedUntil) a.message = 'Error, retrying later';
      });
    }
    apiBusy = false;
  }

  function savePlayer(p) {
    setTimer('energy', { current: p.current_energy, max: p.max_energy });
    setTimer('qp', { current: p.current_quest_points, max: p.max_quest_points });
    setTimer('hp', { current: p.current_health, max: p.max_health });
    const expires = p.safe_mode_expires_at ? Date.parse(p.safe_mode_expires_at) : null;
    setTimer('safeMode', { active: !!p.safe_mode, endsAt: expires });

    update(KEY.data, (d) => {
      d.player = {
        id: p.id, name: p.name, level: p.level,
        gold: p.currencies ? p.currencies.gold : null,
        diamonds: p.currencies ? p.currencies.diamonds : null,
        steps: p.statistics ? p.statistics.steps : null,
        location: p.location ? p.location.name : null,
        seenAt: Date.now()
      };
    });

    // Each level needs 50 x level EXP, so total EXP at the start of level L is 25 x L x (L - 1).
    const level = p.level;
    const into = p.experience - 25 * level * (level - 1);
    const needed = 50 * level;
    if (into >= 0 && into <= needed) setTimer('level', { level: level, into: into, needed: needed, gainedSince: 0 });
  }

  // The Battle page's "next boss" is what the game itself shows, so it wins.
  // The API list only fills in details, or the timer when the page hasn't been read yet.
  function saveBosses(list) {
    if (!Array.isArray(list)) return;
    const now = Date.now();
    const current = load(KEY.timers, {}).boss;
    if (current && !current.fromApi && current.endsAt > now) {
      const same = list.find((b) => b.name === current.name);
      if (same) setTimer('boss', Object.assign({}, current, { level: same.level, hp: same.current_hp, maxHp: same.max_hp }));
      return;
    }
    // The Battle page recently said there's no boss coming up; that's what the game shows, so it wins.
    if (current && !current.fromApi && current.none && now - current.seenAt < 30 * MIN) return;
    const next = list
      .map((b) => ({ name: b.name, level: b.level, hp: b.current_hp, maxHp: b.max_hp, at: b.enable_time * 1000 }))
      .filter((b) => b.at > now)
      .sort((a, b) => a.at - b.at)[0];
    if (next) setTimer('boss', { endsAt: next.at, name: next.name, level: next.level, hp: next.hp, maxHp: next.maxHp, fromApi: true });
    else if (!current || current.none || !current.endsAt || current.endsAt <= now) setTimer('boss', { none: true, endsAt: null, fromApi: true });
  }

  function saveSkills(list) {
    if (Array.isArray(list)) update(KEY.data, (d) => { d.skills = list; d.skillsAt = Date.now(); });
  }

  function saveOrphanage(list) {
    if (!Array.isArray(list)) return;
    update(KEY.data, (d) => { d.orphanage = list; d.orphanageAt = Date.now(); });
    // Tell you once when Tier 3 becomes active.
    const level = orphanageLevel(list);
    const alerted = load(KEY.alerted, {});
    if (level.active >= 3) {
      if (!alerted.orphanage3) {
        alerted.orphanage3 = Date.now();
        save(KEY.alerted, alerted);
        if (settings.alerts.orphanage3 && rowShown('orphanage')) cue('Orphanage Tier 3 is active!', 880);
      }
    } else if (alerted.orphanage3) {
      delete alerted.orphanage3;
      save(KEY.alerted, alerted);
    }
  }

  // The highest active tier (0 = none) and the tier being filled now.
  function orphanageLevel(tiers) {
    const number = (t) => parseInt(String(t.tier && (t.tier.key || t.tier.name) || '').replace(/\D/g, ''), 10) || 0;
    let active = 0;
    tiers.forEach((t) => { if (t.is_active) active = Math.max(active, number(t)); });
    const filling = tiers.find((t) => t.in_progress && !t.is_active);
    return { active: active, filling: filling || null, fillingNumber: filling ? number(filling) : 0 };
  }

  function saveMarket(list) {
    if (!Array.isArray(list)) return;
    const listings = list
      .filter((l) => l.diamonds_remaining > 0)
      .map((l) => ({ price: l.price_per_diamond, amount: l.diamonds_remaining, seller: l.seller ? l.seller.name : '?' }))
      .sort((a, b) => a.price - b.price);
    update(KEY.data, (d) => { d.market = { listings: listings.slice(0, 10), count: listings.length, seenAt: Date.now() }; });

    const cheapest = listings[0];
    if (cheapest && settings.marketMaxPrice > 0 && cheapest.price <= settings.marketMaxPrice) {
      const alerted = load(KEY.alerted, {});
      const tag = cheapest.price + ':' + cheapest.seller;
      if (alerted.market !== tag) {
        alerted.market = tag;
        save(KEY.alerted, alerted);
        cue('Diamond Market: ' + fmt(cheapest.price) + ' gold per diamond (' + cheapest.amount + ' left)', 990);
      }
    }
  }

  // ===========================================================================
  // 6. Reading the page you're on
  // ===========================================================================
  function findAlpineData(key) {
    for (const el of document.querySelectorAll('[x-data]')) {
      const data = el._x_dataStack && el._x_dataStack[0];
      if (data && key in data) return data;
    }
    return null;
  }

  // "Energy Points 17/30" boxes, used when there's no API key.
  function readPoints(label, doc) {
    const leaves = [...(doc || document).querySelectorAll('main *')].filter((el) => el.children.length === 0 && el.textContent.trim() === label);
    for (const leaf of leaves) {
      let box = leaf;
      for (let i = 0; i < 4 && box; i++) {
        box = box.parentElement;
        if (!box || box.querySelector('.stc-ui')) break; // don't read our own cards
        const count = (box.innerText || '').match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/);
        if (count) return { current: toNumber(count[1]), max: toNumber(count[2]) };
      }
    }
    return null;
  }

  function readCurrentPage() {
    if (PATH.startsWith('/preferences/customisation')) rememberLayoutSetting(parseLayoutSetting(document.documentElement.innerHTML));
    const source = SOURCES[PATH];
    if (source) scheduleSource(PATH, source(document.documentElement.innerHTML));

    if (!settings.apiKey) {
      const energy = readPoints('Energy Points');
      if (energy) setTimer('energy', energy);
      const qp = readPoints('Quest Points');
      if (qp) setTimer('qp', qp);
    }

    if (PATH.startsWith('/crafting')) {
      const text = ((document.querySelector('main') || document.body).innerText || '').replace(/\s+/g, ' ');
      if (!/not currently crafting/i.test(text)) {
        const i = text.indexOf('updated hourly.');
        const ms = parseDuration(i === -1 ? null : text.slice(i + 15, i + 315));
        if (ms !== null) setTimer('crafting', { active: true, endsAt: Date.now() + ms });
      }
    }

    if (isTravelPage) {
      const data = findAlpineData('sprint');
      if (data && data.sprint) {
        setTimer('sprint', data.sprint.active ? { active: true, endsAt: Date.now() + data.sprint.ms_remaining } : { active: false, endsAt: null });
      }
    }

    learnCollectionFromPage();
  }

  // ===========================================================================
  // 7. Collection (which items you already have in your collection)
  // ===========================================================================
  function collectionNames() {
    return new Set(load(KEY.collection, { names: [] }).names);
  }

  function addToCollection(names) {
    if (!names.length) return;
    update(KEY.collection, (c) => {
      const set = new Set(c.names || []);
      names.forEach((n) => set.add(n.toLowerCase()));
      c.names = [...set];
      c.updatedAt = Date.now();
    }, { names: [] });
  }

  function removeFromCollection(name) {
    const key = String(name || '').toLowerCase();
    update(KEY.collection, (c) => {
      const i = (c.names || []).indexOf(key);
      if (i !== -1) { c.names.splice(i, 1); c.updatedAt = Date.now(); }
    }, { names: [] });
  }

  // Collection pages that list item names (Items, Collectables and some Avatars).
  const COLLECTION_PAGES = ['items', 'collectables', 'avatars'];

  // When you browse your own Collections pages, remember what's there.
  function learnCollectionFromPage() {
    const id = playerId();
    if (!id) return;
    const m = PATH.match(new RegExp('^/collection/' + id + '/(\\w+)'));
    if (!m || !COLLECTION_PAGES.includes(m[1])) return;
    addToCollection([...document.querySelectorAll('main span[class*="-item"]')].map((s) => s.textContent.trim()).filter(Boolean));
  }

  // The game's item window knows whether an item is in your collection (the green checkmark).
  function learnFromItemWindow(item) {
    if (!item || !item.name || !item.collection) return;
    const collected = Object.values(item.collection).some((v) => v === 1 || v === true);
    const known = collectionNames().has(item.name.toLowerCase());
    if (collected && !known) addToCollection([item.name]);
    if (!collected && known) removeFromCollection(item.name);
  }

  let scanning = false;

  // Read every page of your Items, Collectables and Avatars collections, slowly
  // (a few seconds between pages). Runs by itself once a day, or from the button on your Collections page.
  async function scanCollection(onProgress) {
    const id = playerId();
    if (!id || scanning) return;
    scanning = true;
    const names = [];
    const say = onProgress || function () {};
    try {
      for (const category of COLLECTION_PAGES) {
        for (let page = 1; page <= 200; page++) {
          say('Reading ' + category + ', page ' + page + '\u2026');
          const response = await fetch('/collection/' + id + '/' + category + '?page=' + page, { credentials: 'same-origin' });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
          doc.querySelectorAll('main span[class*="-item"]').forEach((s) => names.push(s.textContent.trim()));
          const hasNext = [...doc.querySelectorAll('main a')].some((a) => a.textContent.trim() === 'Next');
          await wait(3000 + Math.random() * 3000);
          if (!hasNext) break;
        }
      }
      save(KEY.collection, { names: [...new Set(names.filter(Boolean).map((n) => n.toLowerCase()))], updatedAt: Date.now(), scannedAt: Date.now() });
      say('Done: ' + fmt(new Set(names).size) + ' items and collectables');
    } catch (e) {
      update(KEY.collection, (c) => { c.scanFailedAt = Date.now(); }, { names: [] });
      say('Scan stopped (' + e.message + '). It tries again later.');
    }
    scanning = false;
  }

  // Once a day, in the background (only one open tab does it).
  function autoScanCollection() {
    if (!settings.backgroundChecks || scanning || !isLeader()) return;
    const c = load(KEY.collection, { names: [] });
    const last = Math.max(c.scannedAt || 0, c.scanFailedAt || 0);
    if (Date.now() - last > 24 * 3600000) scanCollection();
  }

  // ===========================================================================
  // 8. Timer views (shared by the Companion block, cards and alerts)
  // ===========================================================================
  const TIMERS = [
    { id: 'energy',      name: 'Energy',             short: 'EP',     page: '/battle' },
    { id: 'qp',          name: 'Quest Points',       short: 'QP',     page: '/quests/viewall' },
    { id: 'job',         name: 'Job shift',          short: 'Job',    page: '/profession' },
    { id: 'crafting',    name: 'Crafting',           short: 'Craft',  page: '/crafting/menu' },
    { id: 'sprint',      name: 'Sprint',             short: 'Sprint', page: '/travel' },
    { id: 'worshipBuff', name: 'Worship buff',       short: 'Buff',   page: '/temple' },
    { id: 'worship',     name: 'Temple daily reset', short: 'Temple', page: '/temple' },
    { id: 'tasks',       name: 'Daily tasks reset',  short: 'Tasks',  page: '/tasks/viewall' },
    { id: 'boss',        name: 'Next world boss',    short: 'Boss',   page: '/battle' },
    { id: 'safeMode',    name: 'Safe mode',          short: 'Safe',   page: '/user/character' }
  ];

  const DAILIES = [
    { id: 'orphanageBuff', name: 'Orphanage daily buff', page: '/orphanage' },
    { id: 'worshipUse',    name: 'Temple worship',       page: '/temple' }
  ];

  // Every row of the Companion block, for showing or hiding them (Settings).
  const SIDE_ROWS = [{ id: 'level', name: 'Level progress' }]
    .concat(TIMERS.map((d) => ({ id: d.id, name: d.name })))
    .concat(DAILIES.map((d) => ({ id: d.id, name: d.name })))
    .concat([{ id: 'orphanage', name: 'Orphanage tier' }, { id: 'hp', name: 'HP' }, { id: 'messages', name: 'Messages' }]);

  // Hidden rows also stop alerting and don't count toward the badge.
  function rowShown(id) { return !(settings.hiddenRows || []).includes(id); }

  const ready = (text) => '<span class="stc-ready">' + text + '</span>';
  const muted = (text) => '<span class="stc-muted">' + text + '</span>';

  // "14:35", "tmrw 09:10" or "Sat 09:10" in your own time zone.
  function clockTime(at) {
    const d = new Date(at);
    const today = new Date();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === today.toDateString()) return time;
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    if (d.toDateString() === tomorrow.toDateString()) return 'tmrw ' + time;
    return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
  }

  // When something is ready: the local time, or a countdown. Click it to switch (for all of them).
  function when(at, now) {
    const text = settings.timeMode === 'countdown' ? formatDuration(at - now) : clockTime(at);
    return '<span class="stc-when" data-time-toggle title="Click to switch between clock time and countdown">' + text + '</span>';
  }
  const atOrIn = () => (settings.timeMode === 'countdown' ? 'in ' : 'at ');

  // EP / QP: work out the current value from the last reading (+1 at every 5-minute mark),
  // and when it reaches your target (set in Settings; full if you haven't set one).
  function pointsTarget(id, max) {
    const wanted = parseInt(settings[id === 'energy' ? 'energyTarget' : 'qpTarget'], 10);
    return wanted > 0 ? Math.min(wanted, max) : max;
  }

  function pointsView(id, t, now) {
    const target = pointsTarget(id, t.max);
    const first = nextRegenTick(t.seenAt);
    const ticks = now >= first ? Math.floor((now - first) / REGEN_MS) + 1 : 0;
    const estimate = Math.min(t.max, t.current + ticks);
    const fullAt = first + (t.max - t.current - 1) * REGEN_MS;
    const tail = estimate >= t.max ? ' Full' : ' \u00B7 full ' + atOrIn() + when(fullAt, now);
    const goal = target < t.max ? target + ' ' + atOrIn() : 'full ' + atOrIn();

    // Already at the target when it was read: nothing to wait for (and no alert).
    if (t.current >= target) return { html: ready(estimate + '/' + t.max) + muted(tail), compact: ready(estimate >= t.max ? 'Full' : estimate + '/' + t.max), endsAt: null, isReady: true };
    const targetAt = first + (target - t.current - 1) * REGEN_MS;
    if (now >= targetAt) return { html: ready(estimate + '/' + t.max) + muted(tail), compact: ready(estimate >= t.max ? 'Full' : estimate + '/' + t.max), endsAt: targetAt, isReady: true };
    return {
      html: estimate + '/' + t.max + ' \u00B7 ' + goal + when(targetAt, now),
      compact: estimate + '/' + t.max + ' ' + muted(when(targetAt, now)),
      endsAt: targetAt,
      isReady: false
    };
  }

  function timerView(id, timers, now) {
    const t = timers[id];
    if (!t) return { html: muted('Not checked yet'), compact: muted('—'), endsAt: null, isReady: false };

    if (id === 'energy' || id === 'qp') return pointsView(id, t, now);
    if (id === 'boss' && t.none) return { html: muted('None scheduled'), compact: muted('None'), endsAt: null, isReady: false };
    // A boss that became available hours ago and hasn't been re-read since: don't claim it's still there.
    if (id === 'boss' && t.endsAt && now - t.endsAt > 2 * 3600000) return { html: muted('Checking\u2026'), compact: muted('\u2026'), endsAt: null, isReady: false };
    if (id === 'job' && !t.working) return { html: ready('Not working'), compact: ready('Free'), endsAt: null, isReady: true };
    if (id === 'crafting' && !t.active) return { html: ready('Idle'), compact: ready('Idle'), endsAt: null, isReady: true };
    if (id === 'crafting' && !t.endsAt) return { html: 'Busy ' + muted('(open page for time)'), compact: 'Busy', endsAt: null, isReady: false };
    if ((id === 'sprint' || id === 'worshipBuff' || id === 'safeMode') && !t.active) {
      return { html: muted('Not active'), compact: muted('Off'), endsAt: null, isReady: false };
    }
    if (!t.endsAt) return { html: muted('—'), compact: muted('—'), endsAt: null, isReady: false };

    const label = t.name ? muted(escapeHtml(t.name)) + ' ' : '';
    if (t.endsAt <= now) {
      const word = id === 'boss' ? 'Now' : 'Ready';
      return { html: label + ready(word), compact: ready(word), endsAt: t.endsAt, isReady: true };
    }
    const left = when(t.endsAt, now);
    return { html: label + left, compact: left, endsAt: t.endsAt, isReady: false };
  }

  function dailyView(id, timers) {
    const d = timers[id];
    if (!d) return muted('Not checked yet');
    const reset = timers.tasks && timers.tasks.endsAt;
    const resetSince = reset && d.seenAt < reset && reset <= Date.now();
    return d.available || resetSince ? ready('Available') : muted('Done today');
  }

  // Job shift: how much has been earned so far and in total.
  // Shifts are counted in minutes, and rewards are per minute worked.
  function jobEarnings(t, now) {
    if (!t || !t.working || !t.finalAmount) return null;
    const minutesLeft = Math.max(0, Math.ceil((t.endsAt - now) / MIN));
    const done = Math.max(0, Math.min(t.finalAmount, t.finalAmount - minutesLeft));
    return {
      done: done, total: t.finalAmount,
      goldNow: done * t.rewardGold, goldTotal: t.finalAmount * t.rewardGold,
      expNow: done * t.rewardExp, expTotal: t.finalAmount * t.rewardExp,
      skillNow: done * t.rewardSkillExp, skillTotal: t.finalAmount * t.rewardSkillExp
    };
  }

  // ---------------------------------------------------------------------------
  // EXP per step and steps to the next level
  // ---------------------------------------------------------------------------
  // The steps estimate only uses the EXP the steps themselves give (averaged over your last
  // 100 steps, including steps that gave nothing). Fights and gathering are left out on purpose.
  const WINDOW_STEPS = 100;

  // Total EXP needed to reach this level and progress bar: 25 x L x (L - 1) + share of 50 x L.
  function totalProgress(level, pct) {
    return 25 * level * (level - 1) + (pct / 100) * 50 * level;
  }

  function recordStepSample(level, pct, stepExp) {
    update(KEY.expWindow, (w) => {
      w.push({ t: Date.now(), p: level && typeof pct === 'number' ? totalProgress(level, pct) : null, e: stepExp });
      if (w.length > WINDOW_STEPS) w.splice(0, w.length - WINDOW_STEPS);
    }, []);
  }

  function walkingExpPerStep() {
    const walk = load(KEY.expWindow, []).map((x) => x.e).filter((x) => typeof x === 'number');
    if (walk.length >= 3) return { avg: walk.reduce((a, b) => a + b, 0) / walk.length, samples: walk.length };
    const life = load(KEY.lifetime, { steps: 0, exp: 0 });
    return { avg: life.steps ? life.exp / life.steps : 0, samples: life.steps || 0 };
  }

  function levelInfo(timers) {
    const lv = timers.level;
    if (!lv) return null;
    const gained = lv.gainedSince || 0;
    const left = lv.needed - lv.into - gained;
    const pct = Math.min(100, ((lv.into + gained) / lv.needed) * 100);
    const est = walkingExpPerStep();
    return {
      level: lv.level, approx: lv.approx, left: left, pct: pct, avg: est.avg, samples: est.samples,
      steps: left > 0 && est.avg > 0 ? Math.ceil(left / est.avg) : null
    };
  }

  // Your total EXP right now: from the API (or the Travel page's EXP bar), plus step EXP since.
  function currentTotalExp() {
    const lv = load(KEY.timers, {}).level;
    if (!lv) return null;
    return 25 * lv.level * (lv.level - 1) + lv.into + (lv.gainedSince || 0);
  }

  // All EXP gained this session: steps, fights, gathering and anything else.
  // Without an API key the EXP bar only moves in 1% jumps, so the walking EXP is the minimum.
  function sessionExp() {
    if (!session.active) return 0;
    const total = currentTotalExp();
    if (total === null || session.startTotal === undefined || session.startTotal === null) return session.exp;
    return Math.max(session.exp, total - session.startTotal);
  }


  // ===========================================================================
  // 9. Cues and alerts
  // ===========================================================================
  let audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) { try { audioCtx = new AudioContext(); } catch (e) { audioCtx = null; } }
  }
  document.addEventListener('pointerdown', ensureAudio, { once: true });

  function beep(frequency, durationMs) {
    if (!settings.soundOn || !audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = frequency;
    gain.gain.value = settings.volume;
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + durationMs / 1000);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + durationMs / 1000);
  }

  function notify(message) {
    if (!settings.desktopNotify || !document.hidden) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    new Notification('SMMO Companion', { body: message });
  }

  function cue(message, frequency) {
    beep(frequency || 660, 250);
    notify(message);
    showToast(message);
  }

  const originalTitle = document.title;
  function setTitleReady(isReady) {
    document.title = settings.titleCue && isReady ? '✅ Ready | ' + originalTitle : originalTitle;
  }

  // Ended cooldowns (with the bell on) that you haven't looked at yet.
  // You've seen one once you hovered the Companion block, or visited its page.
  function unseenCooldownIds(timers, now, markAll) {
    const seen = load(KEY.seen, {});
    const ids = [];
    let changed = false;
    TIMERS.forEach(function (def) {
      if (!settings.alerts[def.id] || !timers[def.id] || !rowShown(def.id)) return;
      const view = timerView(def.id, timers, now);
      if (!view.isReady) return;
      const token = String(view.endsAt || 'idle'); // which "ready" this is, so a new one counts again
      const before = seen[def.id];
      if (before === token) return;
      // Same ending read twice (times can differ by a few seconds), or a seen ending that
      // later shows as "Free"/"Idle"/"Full": not new.
      const sameEnding = before && before !== 'idle' && token !== 'idle' && Math.abs(Number(before) - Number(token)) < MIN;
      const settled = before && before !== 'idle' && token === 'idle' && Number(before) <= now;
      if (sameEnding || settled) {
        seen[def.id] = token;
        changed = true;
        return;
      }
      if (markAll || PATH.startsWith(def.page)) {
        seen[def.id] = token;
        changed = true;
      } else {
        ids.push(def.id);
      }
    });
    if (changed) save(KEY.seen, seen);
    return ids;
  }

  function alreadyAlerted(alerted, key, endsAt) {
    return alerted[key] && Math.abs(alerted[key] - endsAt) < MIN;
  }

  // One alert per finished timer (plus an optional early warning). Only the leader tab alerts.
  function checkAlerts() {
    if (!isLeader()) return;
    const timers = load(KEY.timers, {});
    const alerted = load(KEY.alerted, {});
    const now = Date.now();
    let changed = false;

    TIMERS.forEach(function (def) {
      if (!rowShown(def.id)) return;
      const view = timerView(def.id, timers, now);
      if (!view.endsAt) return;

      if (view.isReady && !alreadyAlerted(alerted, def.id, view.endsAt)) {
        alerted[def.id] = view.endsAt;
        changed = true;
        if (settings.alerts[def.id] && now - view.endsAt < 10 * MIN) {
          const t = timers[def.id];
          const points = (def.id === 'energy' || def.id === 'qp') && t && t.max;
          const target = points ? pointsTarget(def.id, t.max) : 0;
          cue(points ? def.name + ': ' + (target >= t.max ? 'full (' + t.max + ')' : target + '/' + t.max + ' reached') : def.name + ': ready');
        }
      }

      const warnMs = settings.warnMinutes * MIN;
      const left = view.endsAt - now;
      if (warnMs > 0 && left > 0 && left <= warnMs && !alreadyAlerted(alerted, def.id + ':early', view.endsAt)) {
        alerted[def.id + ':early'] = view.endsAt;
        changed = true;
        if (settings.alerts[def.id]) cue(def.name + ' in ' + Math.ceil(left / MIN) + ' min', 520);
      }
    });
    if (changed) save(KEY.alerted, alerted);
  }

  // The game sometimes asks you to prove you're human. Tell you, so you can do it yourself.
  let verifyShown = false;
  function checkVerification() {
    if (!settings.verifyAlert) return;
    const visible = humanCheckShowing();
    if (visible && !verifyShown) cue('The game wants you to verify you’re human. Open it and complete it yourself.', 330);
    verifyShown = visible;
  }

  // ===========================================================================
  // 10. Styles (matched to the game's own look: Inter, dark cards, indigo accents)
  // ===========================================================================
  const style = document.createElement('style');
  style.textContent = `
    :root {
      --stc-card: #111111; --stc-border: #262626; --stc-text: #e5e5e5; --stc-muted: #8a8a8a;
      --stc-accent: #6366f1; --stc-accent-strong: #4f46e5; --stc-ready: #22c55e; --stc-warn: #f59e0b; --stc-bad: #ef4444;
      --stc-track: rgba(115,115,115,.25);
    }
    /* The game switches to light mode by removing class="dark" from <html>. */
    html:not(.dark) { --stc-card: #ffffff; --stc-border: #e5e5e5; --stc-text: #262626; --stc-muted: #737373; }
    html:not(.dark) .stc-strip b { color: #111; }
    .stc-ui, #stc-settings, #stc-toast, #stc-dock, #stc-notes, #stc-page-pop { font-family: Inter, sans-serif; }
    .stc-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 2px 0; }
    .stc-row > span:last-child { font-variant-numeric: tabular-nums; text-align: right; }
    .stc-muted { color: var(--stc-muted); }
    .stc-ready { color: var(--stc-ready); font-weight: 600; }
    .stc-warn { color: var(--stc-warn); }
    .stc-row a, .stc-side a, .stc-card a { color: inherit; text-decoration: none; }
    .stc-row a:hover, .stc-side a:hover, .stc-card a:hover { text-decoration: underline; }
    .stc-note { margin-top: 6px; font-size: 11px; color: var(--stc-muted); }
    .stc-bar { height: 6px; border-radius: 3px; background: var(--stc-track); overflow: hidden; margin: 4px 0; }
    .stc-bar div { height: 100%; width: 0; background: var(--stc-accent); border-radius: 3px; }
    .stc-icon-btn { background: none; border: none; color: var(--stc-muted); cursor: pointer; padding: 0 2px; font-size: 12px; line-height: 1; }
    .stc-icon-btn:hover { color: var(--stc-text); }
    .stc-unread { margin-left: 4px; padding: 0 6px; border-radius: 9999px; background: var(--stc-bad); color: #fff; font-size: 10px; font-weight: 700; }
    .stc-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #737373; flex: none; }
    .stc-dot.ready { background: var(--stc-ready); box-shadow: 0 0 6px var(--stc-ready); }
    .stc-dot.wait { background: var(--stc-warn); }
    .stc-dot.blocked { background: var(--stc-bad); }

    /* Companion block in the game's left menu */
    .stc-side { margin: 0 0 18px; padding: 0 4px; font-size: 12px; line-height: 1.5; color: var(--stc-text); }
    .stc-side-head { display: flex; align-items: center; justify-content: space-between; }
    .stc-side-head .stc-tools { display: flex; gap: 6px; align-items: center; }
    .stc-side-box { margin: 0 8px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--stc-border); background: rgba(255,255,255,.02); }
    .stc-side .stc-row { padding: 1px 0; }
    .stc-side .stc-name { display: inline-flex; align-items: center; gap: 4px; }
    .stc-side .stc-bell { opacity: 0; transition: opacity .15s; }
    .stc-side .stc-row:hover .stc-bell, .stc-side .stc-bell.off { opacity: .8; }
    .stc-side .stc-new > span:first-child::before { content: ''; display: inline-block; width: 6px; height: 6px; margin-right: 5px;
      border-radius: 50%; background: var(--stc-accent); vertical-align: middle; }
    .stc-side-new { margin: 0; padding: 0 1.5rem 0 1rem; font-size: 13px; flex: none; }
    .stc-side-new .stc-side-box { max-height: 55vh; overflow-y: auto; }
    .stc-rows-pick { margin: 6px 0 4px; }
    .stc-rows-pick summary { cursor: pointer; padding: 4px 0; }
    .stc-rows-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 12px; margin-top: 6px; }
    .stc-rows-grid label { display: flex !important; align-items: center; gap: 6px; justify-content: flex-start !important; }
    .stc-side-new .stc-side-head { cursor: default; }
    .stc-side-new .stc-side-fold { cursor: pointer; flex: 1; }
    .stc-side-new .stc-side-chevron { cursor: pointer; display: inline-flex; transition: transform .15s; }
    .stc-side-new .stc-side-chevron svg { width: 16px; height: 16px; }
    .stc-side-new .stc-side-box { margin: 8px 0 0; }
    .stc-side .stc-sep { height: 1px; background: var(--stc-border); margin: 6px 0; }
    .stc-badge { min-width: 16px; padding: 0 5px; border-radius: 9999px; background: var(--stc-accent-strong); color: #fff; font-size: 10px; font-weight: 700; line-height: 16px; text-align: center; }
    .stc-when { cursor: pointer; }
    .stc-when:hover { text-decoration: underline dotted; }
    .stc-planner select, .stc-planner input[type=time] { padding: 4px 8px; border-radius: 6px; border: 1px solid var(--stc-border);
      background: #0a0a0a; color: var(--stc-text); font: inherit; font-size: 13px; }
    html:not(.dark) .stc-planner select, html:not(.dark) .stc-planner input[type=time] { background: #fff; }
    .stc-plan-row { display: grid; grid-template-columns: 1.2fr 1fr 1fr 1fr; gap: 8px; padding: 6px 0; border-top: 1px solid var(--stc-border); align-items: baseline; }
    .stc-plan-row:first-child { border-top: none; }
    .stc-plan-row b { font-size: 15px; }
    .stc-plan-row { grid-template-columns: 1.1fr 1fr 1fr 1fr auto; }
    .stc-plan-row[data-plan-pick] { cursor: pointer; border-radius: 6px; padding-left: 6px; padding-right: 6px; }
    .stc-plan-row[data-plan-pick]:hover { background: var(--stc-hover, rgba(99,102,241,.08)); }
    .stc-plan-off { opacity: .6; }
    .stc-plan-use { color: #6366f1; font-size: 12px; font-weight: 600; align-self: center; }
    .stc-plan-toggle { width: 100%; background: none; border: 0; padding: 0; cursor: pointer; color: inherit; font: inherit; text-align: left; }
    .stc-quest-top { display: block; width: 100%; text-align: left; background: none; border: 1px solid var(--stc-border); border-radius: 8px; padding: 10px; cursor: pointer; color: inherit; font: inherit; }
    .stc-quest-top:hover { background: var(--stc-hover, rgba(99,102,241,.08)); }
    .stc-quest-top .stc-bar { display: block; margin: 6px 0; }
    .stc-quest-top .stc-bar span { background: var(--stc-accent); border-radius: 3px; }
    .stc-seg { display: inline-flex; border: 1px solid var(--stc-border); border-radius: 6px; overflow: hidden; }
    .stc-seg button { background: none; border: 0; padding: 4px 10px; font: inherit; font-size: 12px; color: var(--stc-muted); cursor: pointer; }
    .stc-seg button + button { border-left: 1px solid var(--stc-border); }
    .stc-seg button.on { background: var(--stc-accent); color: #fff; }
    .stc-flash { outline: 3px solid #6366f1 !important; outline-offset: 2px; border-radius: 8px; transition: outline-color .3s; }
    .stc-points { cursor: pointer; border-bottom: 1px dashed transparent; }
    .stc-points:hover { border-bottom-color: var(--stc-muted); }
    .stc-target-edit { display: flex; gap: 4px; align-items: center; justify-content: flex-end; }
    .stc-target-edit input { width: 52px; padding: 1px 4px; font-size: 12px; border-radius: 4px; border: 1px solid var(--stc-border); background: #0a0a0a; color: var(--stc-text); }
    .stc-target-edit button { font-size: 11px; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--stc-border); background: #1f1f1f; color: var(--stc-text); cursor: pointer; }

    /* Cards placed on the game's pages */
    .stc-card { margin-top: 12px; font-size: 13px; line-height: 1.5; }
    #stc-page-card { margin: 0 0 16px; }
    .stc-card-title { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .stc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px 24px; }
    .stc-section-title { margin: 0 0 4px; font-size: 12px; font-weight: 600; letter-spacing: .6px; text-transform: uppercase; color: #737373; }
    .stc-btns { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
    .stc-card button[disabled] { opacity: .45; cursor: default; }
    .stc-rarity-chip { display: inline-block; padding: 0 8px; margin: 2px 4px 2px 0; border-radius: 9999px; background: var(--stc-track); font-size: 12px; }

    /* Strip on the Travel page, with the session details dropdown */
    /* No stacking level of its own, so the game's menus (level 20) open over the bar. The dropdown sits at 15:
       above the travel scene (level 10), below the game's menus. */
    .stc-strip-wrap { position: relative; }
    .stc-strip .stc-strip-items { display: contents; }
    .stc-details-btn { margin-left: auto; padding: 2px 10px; border-radius: 6px; border: 1px solid var(--stc-border);
      background: transparent; color: var(--stc-text); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; }
    .stc-details-btn:hover { background: var(--stc-track); }
    .stc-strip-wrap.open .stc-details-btn { border-color: var(--stc-accent); }
    .stc-dropdown { display: none; position: absolute; z-index: 15; right: 0; top: calc(100% + 6px); width: 300px; max-height: 72vh; overflow: auto;
      margin: 0; font-size: 12px; line-height: 1.45; box-shadow: 0 16px 40px rgba(0,0,0,.55); }
    .stc-dropdown .stc-btns { margin-top: 8px; }
    .stc-dropdown .stc-btns button { font-size: 12px; padding: 6px 10px; }
    .stc-strip-wrap.open .stc-dropdown { display: block; }
    .stc-grid-1 { grid-template-columns: 1fr; gap: 14px; }
    /* Strip on the Travel page */
    .stc-strip { margin: 8px 0 0; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--stc-border); background: var(--stc-card);
      color: var(--stc-text); font-size: 13px; line-height: 1.5; display: flex; flex-wrap: wrap; gap: 4px 18px; align-items: center; }
    .stc-strip b { font-weight: 600; color: #fff; }
    .stc-strip .stc-bar { width: 120px; display: inline-block; vertical-align: middle; margin: 0 6px; }
    .stc-chip { display: inline-block; padding: 0 6px; margin: 1px 2px 1px 0; border-radius: 9999px; background: var(--stc-track); font-size: 11px; }

    /* Collection badges on item rows */
    .stc-coll { margin-left: 6px; padding: 0 5px; border-radius: 6px; font-size: 10px; font-weight: 700; vertical-align: middle; }
    .stc-blocked { opacity: .35 !important; pointer-events: none !important; cursor: not-allowed !important; filter: grayscale(1); }
    .stc-give-note { display: inline-block; margin-left: 6px; font-size: 11px; color: var(--stc-warn); white-space: nowrap; }
    .stc-give-note a { color: inherit; text-decoration: underline; }
    .stc-coll.new { background: var(--stc-accent-strong); color: #fff; }

    /* Settings window (styled like the game's own windows) */
    #stc-settings { position: fixed; inset: 0; z-index: 99995; display: none; align-items: flex-start; justify-content: center;
      background: rgba(0,0,0,.6); padding: 6vh 12px; }
    #stc-settings.open { display: flex; }
    #stc-settings-box { width: min(560px, 100%); max-height: 88vh; overflow: auto; background: var(--stc-card); color: var(--stc-text);
      border: 1px solid var(--stc-border); border-radius: 8px; box-shadow: 0 20px 50px rgba(0,0,0,.6); font-size: 13px; }
    #stc-settings-head { position: sticky; top: 0; display: flex; justify-content: space-between; align-items: center; padding: 12px 16px;
      background: var(--stc-card); border-bottom: 1px solid var(--stc-border); font-weight: 600; font-size: 15px; z-index: 1; }
    #stc-settings-body { padding: 4px 16px 16px; }
    #stc-settings .stc-section-title { margin: 16px 0 6px; }
    #stc-settings label { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 4px 0; }
    #stc-settings input[type=number] { width: 96px; }
    #stc-settings input[type=password] { width: 100%; }
    .stc-ui input[type=number], .stc-ui input[type=password], #stc-settings input[type=number], #stc-settings input[type=password] {
      padding: 4px 8px; border-radius: 6px; border: 1px solid var(--stc-border); background: #0a0a0a; color: var(--stc-text); font-size: 13px; }
    /* The game restyles checkboxes and sliders; use the browser's own inside our UI. */
    #stc-settings input[type=checkbox], .stc-ui input[type=checkbox] {
      appearance: auto; -webkit-appearance: auto; width: 16px; height: 16px; flex: none; accent-color: var(--stc-accent); cursor: pointer; }
    #stc-settings input[type=range] { appearance: none; -webkit-appearance: none; width: 160px; height: 16px; background: transparent; border: none; cursor: pointer; }
    #stc-settings input[type=range]::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: var(--stc-track); }
    #stc-settings input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; margin-top: -5px; border-radius: 50%; background: var(--stc-accent); }
    #stc-settings input[type=range]::-moz-range-track { height: 4px; border-radius: 2px; background: var(--stc-track); }
    #stc-settings input[type=range]::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: var(--stc-accent); border: none; }

    /* Small settings button, only on narrow screens where the game hides its left menu */
    #stc-mobile-btn { position: fixed; left: 12px; bottom: 12px; z-index: 99994; width: 40px; height: 40px; border-radius: 9999px;
      border: 1px solid var(--stc-border); background: var(--stc-card); color: var(--stc-text); font-size: 18px; cursor: pointer; display: none; }

    /* Toasts */
    #stc-toast { position: fixed; z-index: 100000; left: 50%; top: 76px; transform: translateX(-50%); max-width: 440px; padding: 10px 16px;
      border-radius: 8px; background: var(--stc-card); color: var(--stc-text); border: 1px solid var(--stc-accent-strong);
      box-shadow: 0 10px 30px rgba(0,0,0,.5); font-size: 13px; display: none; }

    /* Chat popup: Global and Private */
    #stc-dock { position: fixed; top: 60px; right: 120px; width: 420px; height: 70vh; max-height: 680px; z-index: 99998;
      display: none; flex-direction: column; background: var(--stc-card); border: 1px solid var(--stc-border); border-radius: 8px;
      box-shadow: 0 20px 50px rgba(0,0,0,.6); overflow: hidden; font-size: 13px; color: var(--stc-text); }
    #stc-dock.open { display: flex; }
    #stc-dock-head { display: flex; align-items: stretch; height: 40px; flex: none; border-bottom: 1px solid var(--stc-border); }
    #stc-dock-head button { background: none; border: none; color: var(--stc-muted); cursor: pointer; font: inherit; font-weight: 500; padding: 0 14px; }
    #stc-dock-head button:hover { color: var(--stc-text); }
    #stc-dock-head button.active { color: var(--stc-text); box-shadow: inset 0 -2px 0 var(--stc-accent); }
    #stc-dock-head .stc-dock-close { margin-left: auto; font-size: 16px; }
    #stc-dock-head #stc-dock-back { color: #a5b4fc; padding: 0 10px; border-right: 1px solid var(--stc-border); }
    #stc-dock-body { position: relative; flex: 1; }
    #stc-dock-body iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: var(--stc-card); }
    #stc-dock-hint { padding: 16px; color: var(--stc-muted); }

    /* Game pages in a large popup over the Travel page */
    #stc-page-pop { position: fixed; inset: 0; z-index: 99990; display: none; align-items: center; justify-content: center;
      background: rgba(0,0,0,.6); font-size: 13px; color: var(--stc-text); }
    #stc-page-pop.open { display: flex; }
    #stc-page-box { width: min(1100px, 92vw); height: 86vh; display: flex; flex-direction: column; background: var(--stc-card);
      border: 1px solid var(--stc-border); border-radius: 8px; box-shadow: 0 20px 50px rgba(0,0,0,.6); overflow: hidden; }
    #stc-page-head { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--stc-border); flex: none; }
    #stc-page-title { font-weight: 600; flex: 1; }
    #stc-page-head a { color: #a5b4fc; font-size: 12px; text-decoration: none; }
    #stc-page-head a:hover { text-decoration: underline; }
    #stc-page-head button { background: none; border: none; color: var(--stc-muted); cursor: pointer; font-size: 18px; }
    #stc-page-body { position: relative; flex: 1; }
    #stc-page-body iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: var(--stc-card); }

    /* Notifications popup under the bell */
    #stc-notes { position: fixed; top: 60px; right: 80px; width: 420px; height: 70vh; max-height: 640px; z-index: 99998;
      display: none; flex-direction: column; background: var(--stc-card); border: 1px solid var(--stc-border); border-radius: 8px;
      box-shadow: 0 20px 50px rgba(0,0,0,.6); overflow: hidden; font-size: 13px; color: var(--stc-text); }
    #stc-notes.open { display: flex; }
    #stc-notes-head { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px;
      border-bottom: 1px solid var(--stc-border); font-weight: 600; flex: none; }
    #stc-notes-head a { color: #a5b4fc; font-weight: 400; font-size: 12px; margin-right: 10px; text-decoration: none; }
    #stc-notes-head a:hover { text-decoration: underline; }
    #stc-notes-head button { background: none; border: none; color: var(--stc-muted); cursor: pointer; font-size: 16px; }
    #stc-notes-body { position: relative; flex: 1; }
    #stc-notes-body iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: var(--stc-card); }
  `;
  document.head.appendChild(style);

  const $ = (id) => document.getElementById(id);
  const link = (name, page) => '<a href="' + page + '">' + name + '</a>';

  // The game's own style classes (it uses Tailwind), so our parts look like the rest of the site.
  const GAME = {
    card: 'px-4 bg-white rounded-lg py-4 ring-1 ring-black ring-opacity-5 shadow-sm dark:bg-gray-950 dark:border dark:border-gray-800 text-gray-700 dark:text-gray-300',
    heading: 'px-3 mb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider',
    title: 'font-medium text-gray-700 dark:text-gray-200 text-sm sm:text-base',
    button: 'dark:bg-indigo-600 dark:hover:bg-indigo-700 dark:text-white inline-flex items-center px-3 py-2 border border-transparent shadow-sm text-sm leading-4 font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none',
    button2: 'disabled:opacity-40 rounded-md bg-neutral-300 dark:bg-gray-700 px-3 py-2 text-xs sm:text-sm font-semibold dark:text-white text-gray-700 shadow-sm dark:hover:bg-gray-700/70 hover:bg-gray-400/70'
  };

  const toast = document.createElement('div');
  toast.id = 'stc-toast';
  document.body.appendChild(toast);
  let toastTimer = null;
  function showToast(message) {
    toast.textContent = message;
    toast.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 6000);
  }

  // Only touch the DOM when a value actually changed.
  function setHtml(el, html) {
    if (el && el.innerHTML !== html) el.innerHTML = html;
  }

  // Connect inputs with data-key="..." to the settings (used by the settings window and the market card).
  function bindRowToggles(root) {
    root.querySelectorAll('[data-row-toggle]').forEach(function (box) {
      box.checked = rowShown(box.dataset.rowToggle);
      if (box.dataset.bound) return;
      box.dataset.bound = '1';
      box.addEventListener('change', function () {
        const id = box.dataset.rowToggle;
        const hidden = new Set(settings.hiddenRows || []);
        if (box.checked) hidden.delete(id); else hidden.add(id);
        settings.hiddenRows = [...hidden];
        save(KEY.settings, settings);
      });
    });
  }

  function bindSettingInputs(root) {
    bindRowToggles(root);
    root.querySelectorAll('[data-key]').forEach(function (input) {
      if (input.dataset.bound) return;
      input.dataset.bound = '1';
      const key = input.dataset.key;
      if (input.type === 'checkbox') input.checked = !!settings[key];
      else input.value = settings[key];
      input.addEventListener('change', function () {
        if (input.type === 'checkbox') settings[key] = input.checked;
        else if (input.type === 'number' || input.type === 'range') settings[key] = Math.max(0, parseFloat(input.value) || 0);
        else settings[key] = input.value;
        if (key === 'desktopNotify' && input.checked && 'Notification' in window) Notification.requestPermission();
        save(KEY.settings, settings);
        buildPageExtras();
      });
    });
  }

  // ===========================================================================
  // 11. Settings window
  // ===========================================================================
  const settingsWin = document.createElement('div');
  settingsWin.id = 'stc-settings';
  settingsWin.innerHTML = `
    <div id="stc-settings-box">
      <div id="stc-settings-head"><span>Companion settings</span><button class="stc-icon-btn" data-close-settings title="Close (Esc)" style="font-size:18px">×</button></div>
      <div id="stc-settings-body">
        <div class="stc-section-title">Public API</div>
        <input type="password" id="stc-key" placeholder="Paste your API key" autocomplete="off">
        <div class="stc-btns"><button class="${GAME.button}" id="stc-key-save">Save key</button><button class="${GAME.button2}" id="stc-key-clear">Remove</button></div>
        <div class="stc-note" id="stc-api-status"></div>
        <div class="stc-note">Find it under Public API at the bottom of any game page. It's stored only in this browser, on the game's site.</div>
        <label>API refresh (seconds, min 5) <input type="number" min="5" data-key="apiRefreshSeconds"></label>

        <div class="stc-section-title">Alerts</div>
        <label>Sound <input type="checkbox" data-key="soundOn"></label>
        <label>Volume <input type="range" min="0" max="1" step="0.05" data-key="volume"></label>
        <label>Desktop notifications (tab hidden) <input type="checkbox" data-key="desktopNotify"></label>
        <label>Energy alert at (points, 0 = full) <input type="number" min="0" data-key="energyTarget"></label>
        <label>Quest Points alert at (points, 0 = full) <input type="number" min="0" data-key="qpTarget"></label>
        <label>Early warning (minutes before, 0 = off) <input type="number" min="0" data-key="warnMinutes"></label>
        <label>Alert when human check appears <input type="checkbox" data-key="verifyAlert"></label>
        <label>Alert on new private messages <input type="checkbox" data-key="messageAlert"></label>
        <label>Tab title when step is ready <input type="checkbox" data-key="titleCue"></label>
        <div class="stc-btns"><button class="${GAME.button2}" id="stc-test">Test sound</button></div>
        <div class="stc-note">Turn alerts for each cooldown on or off with the 🔔 next to it in the Companion block.</div>

        <div class="stc-section-title">Sessions</div>
        <label>End session after no activity (minutes, min 5) <input type="number" min="0" data-key="idleResetMinutes"></label>
        <div class="stc-note">A session starts with your first step. If you don't step or fight for this long, it ends at your last action, so the time away isn't counted. 0 = only end it yourself.</div>

        <div class="stc-section-title">On the website</div>
        <label>Companion block in the left menu <input type="checkbox" data-key="showSidebar"></label>
        <details class="stc-rows-pick"><summary>Rows in the Companion block</summary>
          <div class="stc-rows-grid">${SIDE_ROWS.map((r) => '<label><input type="checkbox" data-row-toggle="' + r.id + '"> ' + r.name + '</label>').join('')}</div>
          <div class="stc-note">Unticked rows are hidden, and their alerts stay quiet.</div>
        </details>
        <label>Stats strip and Walking card on Travel <input type="checkbox" data-key="showTravelStrip"></label>
        <label>Info cards on game pages <input type="checkbox" data-key="showPageCards"></label>
        <label>NEW badges on inventory items <input type="checkbox" data-key="collectionMarks"></label>
        <label>Block shop items and uncollected items when giving items away <input type="checkbox" data-key="guardGiving"></label>
        <label>Messages icon opens chat popup <input type="checkbox" data-key="chatPopup"></label>
        <label>Notifications open in a popup <input type="checkbox" data-key="notificationsPopup"></label>
        <label>Shortcuts: Alt+C settings, Alt+M chat <input type="checkbox" data-key="shortcut"></label>

        <div class="stc-section-title">Pages as popups</div>
        <label>Open every game page in a popup <input type="checkbox" data-key="pagePopups"></label>
        <label>Only while on the Travel page <input type="checkbox" data-key="popupsOnlyOnTravel"></label>
        <div class="stc-note">Travel stays your main page. Use \u201COpen full page\u201D at the top of a popup, or Ctrl+click a link, to open the normal page instead.</div>

        <div class="stc-section-title">Background checks</div>
        <label>Check pages in background <input type="checkbox" data-key="backgroundChecks"></label>
        <label>Safety recheck every (minutes, min 2) <input type="number" min="2" data-key="bgRefreshMinutes"></label>
        <div class="stc-note">Pages are also read again 3 seconds after one of their timers ends.</div>

        <div class="stc-section-title">Backup</div>
        <div class="stc-btns"><button class="${GAME.button2}" id="stc-backup-export">Export backup</button><button class="${GAME.button2}" id="stc-backup-import">Import backup</button></div>
        <input type="file" id="stc-backup-file" accept=".json,application/json" style="display:none">
        <div class="stc-note">Saves your settings and sessions to a file you can import in another browser. Your API key isn’t included; paste it again there.</div>
      </div>
    </div>`;
  document.body.appendChild(settingsWin);
  bindSettingInputs(settingsWin);

  // On narrow screens the game hides its left menu, so give settings a small button there.
  const mobileBtn = document.createElement('button');
  mobileBtn.id = 'stc-mobile-btn';
  mobileBtn.title = 'Companion settings';
  mobileBtn.textContent = '⚙';
  document.body.appendChild(mobileBtn);
  mobileBtn.addEventListener('click', () => openSettings());

  function openSettings() {
    closeNotes();
    closeChat();
    settingsWin.classList.add('open');
    bindRowToggles(settingsWin); // show the current choices
    renderApiStatus();
  }

  function closeSettings() { settingsWin.classList.remove('open'); }

  settingsWin.addEventListener('click', function (e) {
    if (e.target === settingsWin || e.target.closest('[data-close-settings]')) closeSettings();
  });

  function renderApiStatus() {
    const api = load(KEY.api, {});
    $('stc-api-status').textContent = settings.apiKey
      ? 'Status: ' + (api.message || 'waiting') + (api.okAt ? ' (updated ' + timeAgo(api.okAt) + ')' : '')
      : 'No key yet. Without it, the companion reads what it can from the game’s pages.';
  }

  // Alt+C: settings. Alt+M: chat popup.
  function onShortcut(e) {
    if (!settings.shortcut || !e.altKey) return;
    if (e.code !== 'KeyM' && isTyping()) return;
    if (e.code === 'KeyC') {
      e.preventDefault();
      if (settingsWin.classList.contains('open')) closeSettings(); else openSettings();
    } else if (e.code === 'KeyM' && settings.chatPopup) {
      e.preventDefault();
      toggleChat();
    }
  }
  document.addEventListener('keydown', onShortcut);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && settingsWin.classList.contains('open')) closeSettings();
  });

  $('stc-key').value = settings.apiKey ? '•'.repeat(12) : '';
  $('stc-key-save').addEventListener('click', function () {
    const value = $('stc-key').value.trim();
    if (!value || /^•+$/.test(value)) return;
    settings.apiKey = value;
    save(KEY.settings, settings);
    save(KEY.api, { message: 'Connecting…' }); // clears "key rejected" so it tries again
    $('stc-key').value = '•'.repeat(12);
    renderApiStatus();
  });
  $('stc-key-clear').addEventListener('click', function () {
    settings.apiKey = '';
    save(KEY.settings, settings);
    save(KEY.api, {});
    $('stc-key').value = '';
    renderApiStatus();
  });
  $('stc-test').addEventListener('click', function () { ensureAudio(); beep(880, 180); });

  // ===========================================================================
  // 12. Session history
  // ===========================================================================
  function archiveSession(s, endAt) {
    if (!s || !s.steps) return;
    update(KEY.history, (h) => {
      h.unshift({ start: s.startedAt, end: endAt, steps: s.steps, gold: s.gold, exp: s.exp, loot: s.loot || {}, fought: s.fought || 0 });
      if (h.length > 200) h.length = 200;
    }, []);
  }

  function endSession(endAt) {
    archiveSession(Object.assign({}, session, { exp: sessionExp() }), endAt);
    session = emptySession();
    save(KEY.session, session);
  }

  // After this long without a step or a fight, the session ends at your last action,
  // so the time you were away isn't counted.
  function idleLimitMs() {
    return settings.idleResetMinutes > 0 ? Math.max(5, settings.idleResetMinutes) * MIN : Infinity;
  }

  function checkSessionIdle() {
    if (!session.active) return;
    const last = session.lastActivityAt || session.startedAt;
    if (Date.now() - last > idleLimitMs()) endSession(last);
  }

  // How long the session has run so far.
  function sessionDuration() {
    return session.active ? Date.now() - session.startedAt : 0;
  }

  function exportHistory() {
    const rows = [['start', 'end', 'minutes', 'steps', 'gold', 'exp', 'fought'].concat(RARITIES)];
    const all = [session].filter((s) => s.active && s.steps).map((s) => ({ start: s.startedAt, end: Date.now(), steps: s.steps, gold: s.gold, exp: sessionExp(), loot: s.loot, fought: s.fought }))
      .concat(load(KEY.history, []));
    all.forEach(function (s) {
      rows.push([
        new Date(s.start).toISOString(), new Date(s.end).toISOString(), Math.round((s.end - s.start) / MIN),
        s.steps, s.gold, s.exp, s.fought || 0
      ].concat(RARITIES.map((r) => (s.loot && s.loot[r]) || 0)));
    });
    const csv = rows.map((r) => r.join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'smmo-sessions.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------------------------------------------------------------------------
  // Backup: move settings and sessions to another browser
  // ---------------------------------------------------------------------------
  // What goes in the file. Timers, API status and caches aren't included: they refill by themselves.
  const BACKUP_KEYS = ['settings', 'session', 'history', 'lifetime', 'expWindow', 'collection', 'seen', 'dock'];

  function exportBackup() {
    const data = {};
    BACKUP_KEYS.forEach(function (name) {
      const raw = localStorage.getItem(KEY[name]);
      if (raw) data[name] = JSON.parse(raw);
    });
    if (data.settings) delete data.settings.apiKey; // keep your key out of the file
    const file = { app: 'smmo-travel-companion', version: 1, exportedAt: new Date().toISOString(), data: data };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
    a.download = 'smmo-companion-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function importBackup(text) {
    let file;
    try { file = JSON.parse(text); } catch (e) { alert('This file isn’t a companion backup.'); return; }
    if (!file || file.app !== 'smmo-travel-companion' || !file.data) { alert('This file isn’t a companion backup.'); return; }
    const sessions = (file.data.history || []).length;
    if (!confirm('Import this backup from ' + String(file.exportedAt || '').slice(0, 10) + '?\n\n' +
      'It replaces your current settings, current session and ' + sessions + ' past sessions in this browser. Your API key here is kept.')) return;
    const keepKey = settings.apiKey;
    BACKUP_KEYS.forEach(function (name) {
      if (!(name in file.data)) return;
      const value = file.data[name];
      if (name === 'settings') value.apiKey = keepKey;
      save(KEY[name], value);
    });
    location.reload(); // start fresh with the imported data
  }

  $('stc-backup-export').addEventListener('click', exportBackup);
  $('stc-backup-import').addEventListener('click', function () { $('stc-backup-file').click(); });
  $('stc-backup-file').addEventListener('change', function () {
    const f = this.files && this.files[0];
    if (!f) return;
    f.text().then(importBackup);
    this.value = '';
  });

  // ===========================================================================
  // 13. Companion block in the left menu
  // ===========================================================================
  let sideEl = null;
  let sideHover = false;

  // The game has two layouts: the classic one, and the new one you can turn on under
  // Preferences > Customisation ("Webapp New Layout"). The page itself shows which one is on;
  // when it can't tell (a page without the menu), the saved setting decides.
  // Read on every page load, since you can switch it at any time.
  let layoutSetting = null; // true / false once read for this page, null until then

  function parseLayoutSetting(html) {
    const at = html.indexOf('wire:key="setting-' + 'webapp_new_layout"'); // split so it never matches this script's own text
    const m = at === -1 ? null : html.slice(at, at + 1500).match(/aria-checked="(true|false)"/);
    return m ? m[1] === 'true' : null;
  }

  function rememberLayoutSetting(value) {
    if (value === null) return;
    const changed = value !== layoutSetting;
    layoutSetting = value;
    update(KEY.data, (d) => { d.newLayout = value; d.newLayoutAt = Date.now(); });
    if (changed) buildPageExtras(); // switch the Companion block over right away
  }

  async function readLayoutSetting() {
    if (PATH.startsWith('/preferences/customisation')) { rememberLayoutSetting(parseLayoutSetting(document.documentElement.innerHTML)); return; }
    try {
      const res = await fetch('/preferences/customisation', { credentials: 'same-origin' });
      if (res.ok) rememberLayoutSetting(parseLayoutSetting(await res.text()));
    } catch (err) { /* offline: the page itself decides */ }
  }

  // Your setting decides. Until it's been read on this page (or if reading fails),
  // the page itself shows which layout is on, and after that the last setting that was read.
  function isNewLayout() {
    if (layoutSetting !== null) return layoutSetting;
    if (document.querySelector('aside a[href*="/inventory"]')) return true;
    if (findSidebarNav()) return false;
    return load(KEY.data, {}).newLayout === true;
  }

  // Where the Companion block goes: the menu of the layout that's on, or whichever menu the page has.
  function sidebarSpot() {
    const newMenu = findNewSidebar();
    const nav = findSidebarNav();
    const wantNew = isNewLayout();
    if (wantNew && newMenu) return { type: 'new', el: newMenu };
    if (!wantNew && nav) return { type: 'classic', el: nav };
    if (newMenu) return { type: 'new', el: newMenu };
    if (nav) return { type: 'classic', el: nav };
    return null;
  }

  // New layout: the scrolling list of menu sections (Main, Play, Character...) in the left menu.
  function findNewSidebar() {
    const inventory = document.querySelector('aside ul a[href*="/inventory"]');
    const section = inventory && inventory.closest('ul').parentElement; // e.g. the "Character" section
    return section && section.parentElement ? section.parentElement : null;
  }

  // The game's left menu (desktop only).
  function findSidebarNav() {
    for (const nav of document.querySelectorAll('nav')) {
      if (nav.querySelector('h3') && nav.querySelector('a[href*="/inventory"]') && isVisible(nav)) return nav;
    }
    return null;
  }

  // Some timers only matter while they're running.
  const ONLY_WHEN_ACTIVE = ['sprint', 'worshipBuff', 'safeMode'];

  // What's inside the Companion block (the same in both layouts).
  function sideBoxHtml() {
    return '<div class="stc-side-box">' +
        '<div class="stc-row stc-warn" data-s="verify" style="display:none">⚠ Human check waiting</div>' +
        '<div data-s="level" data-row="level"></div>' +
        '<div class="stc-sep" data-s="level-sep"></div>' +
        TIMERS.map(function (def) {
          const value = def.id === 'energy' || def.id === 'qp'
            ? '<span class="stc-points" data-points="' + def.id + '" title="Click to set when to be alerted"></span>'
            : '<span data-t="' + def.id + '"></span>';
          return '<div class="stc-row" data-row="' + def.id + '"><span class="stc-name">' + link(def.short, def.page) +
            '<button class="stc-icon-btn stc-bell" data-bell="' + def.id + '"></button></span>' + value + '</div>';
        }).join('') +
        '<div class="stc-sep" data-s="mid-sep"></div>' +
        DAILIES.map((def) => '<div class="stc-row" data-row="' + def.id + '"><span>' + link(def.name.replace('Orphanage daily buff', 'Orphanage buff'), def.page) + '</span><span data-d="' + def.id + '"></span></div>').join('') +
        '<div class="stc-row" data-row="orphanage"><span class="stc-name">' + link('Orphanage', '/orphanage') +
          '<button class="stc-icon-btn stc-bell" data-bell="orphanage3"></button></span><span data-s="orphanage"></span></div>' +
        '<div class="stc-row" data-row="hp"><span class="stc-muted">HP</span><span data-s="hp"></span></div>' +
        '<div class="stc-row" data-row="messages"><span><a href="/messages/inbox" data-dock-private>Messages</a></span><span data-s="msg"></span></div>' +
      '</div>';
  }

  const sideTools = '<span class="stc-tools"><button class="stc-icon-btn" title="Chat (Alt+M)" data-dock-toggle>💬</button>' +
    '<button class="stc-icon-btn" title="Settings (Alt+C)" data-open-settings>⚙</button></span>';

  function buildSidebar() {
    const spot = sidebarSpot();
    if (!spot) return;
    const newMenu = spot.type === 'new' ? spot.el : null;
    const nav = spot.type === 'classic' ? spot.el : null;
    sideEl = document.createElement('div');
    sideEl.dataset.layout = spot.type;
    // Built once so links and buttons stay clickable; renderSidebar() only updates values.
    if (newMenu) {
      // A menu section of its own, above Main, made like the game's sections (and folds the same way).
      const gameHead = newMenu.querySelector(':scope > div > button');
      const chevron = gameHead && gameHead.querySelector('svg') ? gameHead.querySelector('svg').outerHTML : '\u25BE';
      sideEl.className = 'pl-4 pr-6 stc-side stc-side-new stc-ui';
      sideEl.innerHTML =
        '<div class="border-t border-dashed border-gray-700/50 my-4"></div>' +
        '<div class="' + (gameHead ? gameHead.className : '') + ' stc-side-head">' +
          '<span class="stc-side-fold" data-side-fold role="button" title="Fold or unfold">Companion <span class="stc-badge" data-s="badge" style="display:none"></span></span>' +
          '<span style="display:inline-flex;align-items:center;gap:8px">' + sideTools +
          '<span class="stc-side-chevron" data-side-fold role="button">' + chevron + '</span></span></div>' +
        sideBoxHtml();
      // Above the scrolling menu (not inside it), so it stays in view while Main, Play... scroll.
      const aside = newMenu.closest('aside');
      const scroller = (aside && [...aside.querySelectorAll('.overflow-y-auto')].find((el) => el.contains(newMenu))) || newMenu;
      scroller.parentElement.insertBefore(sideEl, scroller);
      scroller.style.flex = '1 1 0%';
      scroller.style.minHeight = '0';
      applySideFold();
    } else {
      sideEl.className = 'stc-side stc-ui';
      sideEl.innerHTML =
        '<h3 class="' + GAME.heading + ' stc-side-head"><span>Companion <span class="stc-badge" data-s="badge" style="display:none"></span></span>' +
          sideTools + '</h3>' + sideBoxHtml();
      nav.insertBefore(sideEl, nav.firstChild);
    }
    // Looking at the block counts as having seen the cooldowns that ended.
    sideEl.addEventListener('mouseenter', () => { sideHover = true; });
    sideEl.addEventListener('mouseleave', () => { sideHover = false; });
  }

  // New layout: the Companion section folds like the game's own sections.
  function applySideFold() {
    if (!sideEl || !sideEl.classList.contains('stc-side-new')) return;
    const folded = !!settings.sideFolded;
    sideEl.querySelector('.stc-side-box').style.display = folded ? 'none' : '';
    const chevron = sideEl.querySelector('.stc-side-chevron');
    if (chevron) chevron.style.transform = folded ? 'rotate(180deg)' : '';
  }

  function bellIcon(id) { return settings.alerts[id] ? '🔔' : '🔕'; }

  function renderSidebar(timers, now, unseenIds) {
    if (!sideEl) return;
    const part = (sel) => sideEl.querySelector(sel);
    const info = levelInfo(timers);
    setHtml(part('[data-s="level"]'), info
      ? '<div class="stc-row"><span>Lv ' + fmt(info.level) + '</span><span>' + info.pct.toFixed(1) + '%' +
        (info.left <= 0 ? ' ' + ready('Level up!') : info.steps ? muted(' · ≈' + fmt(info.steps) + ' steps') : '') + '</span></div>' +
        '<div class="stc-bar"><div style="width:' + info.pct.toFixed(1) + '%"></div></div>'
      : '');
    part('[data-s="level"]').style.display = rowShown('level') ? '' : 'none';
    part('[data-s="level-sep"]').style.display = info && rowShown('level') ? '' : 'none';

    TIMERS.forEach(function (def) {
      const row = part('[data-row="' + def.id + '"]');
      const t = timers[def.id];
      row.style.display = !rowShown(def.id) || (ONLY_WHEN_ACTIVE.includes(def.id) && !(t && t.active)) ? 'none' : '';
      row.classList.toggle('stc-new', unseenIds.includes(def.id));
      const bell = part('[data-bell="' + def.id + '"]');
      setHtml(bell, bellIcon(def.id));
      bell.classList.toggle('off', !settings.alerts[def.id]);
      bell.title = settings.alerts[def.id] ? 'Alert on: click to turn off' : 'Alert off: click to turn on';
      if (def.id === 'energy' || def.id === 'qp') {
        const el = part('[data-points="' + def.id + '"]');
        if (el.dataset.editing) return;
        const target = t && t.max ? pointsTarget(def.id, t.max) : 0;
        setHtml(el, timerView(def.id, timers, now).compact + (t && target && target < t.max ? muted(' →' + target) : ''));
      } else {
        setHtml(part('[data-t="' + def.id + '"]'), timerView(def.id, timers, now).compact);
      }
    });
    DAILIES.forEach((def) => setHtml(part('[data-d="' + def.id + '"]'), dailyView(def.id, timers).replace('Not checked yet', '\u2014')));
    const orphBell = part('[data-bell="orphanage3"]');
    setHtml(orphBell, bellIcon('orphanage3'));
    orphBell.classList.toggle('off', !settings.alerts.orphanage3);
    orphBell.title = settings.alerts.orphanage3 ? 'Alert when Tier 3 is active: on' : 'Alert when Tier 3 is active: off';
    setHtml(part('[data-s="orphanage"]'), orphanageShort(load(KEY.data, {}).orphanage));
    setHtml(part('[data-s="hp"]'), timers.hp ? short(timers.hp.current) + '/' + short(timers.hp.max) : muted('—'));
    ['orphanageBuff', 'worshipUse', 'orphanage', 'hp'].forEach((id) => { part('[data-row="' + id + '"]').style.display = rowShown(id) ? '' : 'none'; });
    // The line between the cooldowns and the rows below only when both have something showing.
    const anyShown = (ids) => ids.some((id) => { const r = part('[data-row="' + id + '"]'); return r && r.style.display !== 'none'; });
    part('[data-s="mid-sep"]').style.display = anyShown(TIMERS.map((d) => d.id)) && anyShown(['orphanageBuff', 'worshipUse', 'orphanage', 'hp', 'messages']) ? '' : 'none';
    part('[data-s="verify"]').style.display = verifyShown ? '' : 'none';
    const badge = part('[data-s="badge"]');
    badge.textContent = unseenIds.length;
    badge.style.display = unseenIds.length ? 'inline-block' : 'none';
  }

  // Click the EP or QP number to choose when to be alerted.
  function editTarget(el) {
    const id = el.dataset.points;
    const t = load(KEY.timers, {})[id] || {};
    const max = t.max || 0;
    const current = parseInt(settings[id === 'energy' ? 'energyTarget' : 'qpTarget'], 10) || 0;
    el.dataset.editing = '1';
    el.innerHTML = '<span class="stc-target-edit">' +
      '<input type="number" min="0" ' + (max ? 'max="' + max + '"' : '') + ' value="' + (current || max || '') + '" title="Alert when you have this many">' +
      '<button data-target-save>OK</button><button data-target-full>Full</button></span>';
    const input = el.querySelector('input');
    input.focus();
    input.select();
    const finish = function (value) {
      const key = id === 'energy' ? 'energyTarget' : 'qpTarget';
      settings[key] = value >= max && max ? 0 : Math.max(0, value || 0); // the maximum means "full"
      save(KEY.settings, settings);
      delete el.dataset.editing;
      showToast((id === 'energy' ? 'Energy' : 'Quest Points') + ' alert: ' + (settings[key] ? 'at ' + settings[key] : 'when full'));
    };
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') finish(parseInt(input.value, 10));
      if (e.key === 'Escape') { e.stopPropagation(); delete el.dataset.editing; }
    });
    el.querySelector('[data-target-save]').addEventListener('click', (e) => { e.stopPropagation(); finish(parseInt(input.value, 10)); });
    el.querySelector('[data-target-full]').addEventListener('click', (e) => { e.stopPropagation(); finish(0); });
  }

  // ===========================================================================
  // 14. Cards on the game's pages
  // ===========================================================================
  let stripWrap = null;
  let stripEl = null;
  let walkCard = null;

  // The session details stay open (or closed) the way you left them, also on the next page load.
  function applyDetailsOpen() {
    if (!stripWrap) return;
    stripWrap.classList.toggle('open', !!settings.walkDetailsOpen);
    stripWrap.querySelector('[data-caret]').textContent = settings.walkDetailsOpen ? '\u25B4' : '\u25BE';
  }
  let pageCard = null;

  // The page's main content column (where the game puts its own boxes).
  function mainColumn() {
    const container = document.querySelector('.web-app-container');
    if (!container) return null;
    return [...container.children].find((el) => /max-w-/.test(el.className) && isVisible(el)) || null;
  }

  function makeCard(id, title, html) {
    const card = document.createElement('div');
    card.id = id;
    card.className = GAME.card + ' stc-card stc-ui';
    card.innerHTML = '<div class="stc-card-title"><span class="' + GAME.title + '">' + title + '</span>' +
      '<span class="stc-muted" style="font-size:11px;margin-left:auto">Companion</span></div>' + html;
    return card;
  }

  // Which card goes on which page.
  function cardForPage() {
    const id = playerId();
    if (PATH === '/home' || PATH === '/') {
      return { title: 'Your progress', html: '<div class="stc-grid">' +
        '<div><div class="stc-section-title">Player</div><div data-c="player"></div></div>' +
        '<div><div class="stc-section-title">Job earnings</div><div data-c="job"></div></div>' +
        '<div><div class="stc-section-title">Skills</div><div data-c="skills"></div></div>' +
        '<div><div class="stc-section-title">Orphanage</div><div data-c="orphanage"></div></div></div>' };
    }
    if (PATH.startsWith('/battle')) {
      return { title: 'Next world boss', html: '<div data-c="boss"></div>' };
    }
    if (id && PATH.startsWith('/collection/' + id)) {
      return { title: 'Collection for NEW badges', html: '<div data-c="collection"></div>' +
        '<div class="stc-btns"><button class="' + GAME.button + '" data-scan>Scan my collection</button></div>' +
        '<div class="stc-note">Reads your Items, Collectables and Avatars collection pages one by one, a few seconds apart. This also happens by itself once a day. Opening an item updates it too: the green checkmark in the item window means it\u2019s collected.</div>' };
    }
    if (PATH.startsWith('/diamond-market')) {
      return { title: 'Diamond Market watcher', html: '<div class="stc-grid">' +
        '<div><div class="stc-section-title">Cheapest listings</div><div data-c="market"></div></div>' +
        '<div><div class="stc-section-title">Watch</div>' +
          '<label class="stc-row">Watch the market <input type="checkbox" data-key="marketWatch"></label>' +
          '<label class="stc-row">Alert at or below (gold per diamond) <input type="number" min="0" data-key="marketMaxPrice"></label>' +
          '<label class="stc-row">Check every (minutes, min 2) <input type="number" min="2" data-key="marketRefreshMinutes"></label>' +
          '<div class="stc-note">Needs your API key. It only reads prices; buying is up to you.</div></div></div>' };
    }
    return null;
  }

  function buildPageExtras() {
    // Companion block
    if (sideEl && sideEl.isConnected) {
      const spot = sidebarSpot();
      if (spot && spot.type !== sideEl.dataset.layout) { sideEl.remove(); sideEl = null; }
    }
    document.documentElement.classList.toggle('stc-new-layout', isNewLayout());
    if (settings.showSidebar && !(sideEl && sideEl.isConnected)) buildSidebar();
    if (!settings.showSidebar && sideEl) { sideEl.remove(); sideEl = null; }
    // Without the left menu (narrow screens), show a small settings button instead.
    mobileBtn.style.display = sideEl && sideEl.isConnected ? 'none' : 'block';

    const container = document.getElementById('complete-travel-container');
    const onTravel = isTravelPage && container && settings.showTravelStrip;

    // Travel strip, between your banner and the travel scene, with the session details as a dropdown.
    // The dropdown opens on the right, beside the step button rather than over it.
    if (onTravel && !(stripWrap && stripWrap.isConnected) && container.firstElementChild) {
      stripWrap = document.createElement('div');
      stripWrap.className = 'stc-strip-wrap stc-ui';
      stripWrap.innerHTML = '<div class="stc-strip"><span class="stc-strip-items"></span>' +
        '<button class="stc-details-btn" data-toggle-details>Session details <span data-caret>\u25BE</span></button></div>';
      stripEl = stripWrap.querySelector('.stc-strip-items');
      walkCard = document.createElement('div');
      walkCard.id = 'stc-walk';
      walkCard.className = GAME.card + ' stc-card stc-dropdown';
      walkCard.innerHTML = walkCardHtml();
      stripWrap.appendChild(walkCard);
      container.insertBefore(stripWrap, container.firstElementChild.nextSibling);
      historyDrawn = null;
      applyDetailsOpen();
    }
    if (!onTravel && stripWrap) {
      stripWrap.remove();
      stripWrap = stripEl = walkCard = null;
    }

    // Cards on other game pages
    if (settings.showPageCards && !(pageCard && pageCard.isConnected)) {
      const def = cardForPage();
      const column = def && mainColumn();
      if (column) {
        pageCard = makeCard('stc-page-card', def.title, def.html);
        column.insertBefore(pageCard, column.firstChild);
        bindSettingInputs(pageCard);
      }
    }
    if (!settings.showPageCards && pageCard) { pageCard.remove(); pageCard = null; }
    if (settings.showPageCards && PATH.startsWith('/profession')) mountPlanner(document, mainColumn());
    if (settings.showPageCards && PATH.startsWith('/quests')) mountQuestHelper(document, mainColumn());
  }

  function walkCardHtml() {
    return '<div class="stc-row" style="margin-bottom:10px"><span style="display:inline-flex;align-items:center;gap:8px">' +
        '<span class="stc-dot" data-w="dot"></span><span data-w="status" style="font-weight:600"></span></span>' +
        '<button class="stc-icon-btn" data-toggle-details title="Close" style="font-size:16px">\u00D7</button></div>' +
      '<div class="stc-grid stc-grid-1">' +
        '<div><div class="stc-section-title">Session</div>' +
          '<div class="stc-row"><span class="stc-muted">Time</span><span data-w="time"></span></div>' +
          '<div class="stc-row"><span class="stc-muted">Steps</span><span data-w="steps"></span></div>' +
          '<div class="stc-row"><span class="stc-muted">Gold</span><span data-w="gold"></span></div>' +
          '<div class="stc-row"><span class="stc-muted">EXP</span><span data-w="exp"></span></div>' +
          '<div class="stc-row"><span class="stc-muted">Per hour</span><span data-w="rates"></span></div>' +
          '<div class="stc-btns"><button class="' + GAME.button + '" data-end-session>End session</button>' +
            '<button class="' + GAME.button2 + '" data-export-csv>Export CSV</button></div></div>' +
        '<div><div class="stc-section-title">Next level</div><div data-w="level"></div></div>' +
        '<div><div class="stc-section-title">Found and fought</div><div data-w="loot"></div>' +
          '<div class="stc-section-title" style="margin-top:10px">Active boosts</div><div data-w="boosts"></div></div>' +
        '<div><div class="stc-section-title">Past sessions</div><div data-w="history"></div></div>' +
      '</div>';
  }

  // ---------------------------------------------------------------------------
  // Walking card and strip (Travel page)
  // ---------------------------------------------------------------------------
  function activeBoosts() {
    const data = isTravelPage ? getTravelData() : null;
    return data ? (data.boosts || []).filter((b) => b && b.value > 0) : null;
  }

  let historyDrawn = null; // only redraw when the list changes, so the remove buttons stay clickable

  function renderWalkCard(timers) {
    if (!walkCard) return;
    const part = (name) => walkCard.querySelector('[data-w="' + name + '"]');
    const elapsed = sessionDuration();
    const hours = Math.max(elapsed / 3600000, 1 / 60);
    const exp = sessionExp();
    setHtml(part('time'), session.active ? formatDuration(elapsed) : muted('Starts with your next step'));
    setHtml(part('steps'), fmt(session.steps));
    setHtml(part('gold'), fmt(session.gold));
    setHtml(part('exp'), fmt(exp));
    setHtml(part('rates'), session.active ? fmt(session.steps / hours) + ' steps · ' + short(exp / hours) + ' EXP' : muted('—'));
    walkCard.querySelector('[data-end-session]').disabled = !session.active;

    const info = levelInfo(timers);
    let stepsText = muted('take a few steps first');
    if (info && info.left <= 0) stepsText = ready('Level up!');
    else if (info && info.steps) stepsText = '≈ ' + fmt(info.steps) + ' steps';
    setHtml(part('level'), info
      ? '<div class="stc-row"><span>Level ' + fmt(info.level) + (info.approx ? muted(' (approx.)') : '') + '</span><span>' + info.pct.toFixed(1) + '%</span></div>' +
        '<div class="stc-bar"><div style="width:' + info.pct.toFixed(1) + '%"></div></div>' +
        '<div class="stc-row"><span class="stc-muted">EXP to go</span><span>' + fmt(Math.max(0, info.left)) + '</span></div>' +
        '<div class="stc-row"><span class="stc-muted">Avg EXP per step</span><span>' + (info.avg ? fmt(info.avg) : '—') + '</span></div>' +
        '<div class="stc-row"><span class="stc-muted">Steps needed</span><span>' + stepsText + '</span></div>' +
        (info.steps ? '<div class="stc-note">Walking EXP only, from your last ' + fmt(Math.min(info.samples, WINDOW_STEPS)) + ' steps.</div>' : '')
      : muted('Add an API key, or take a step'));

    const loot = session.loot || {};
    const total = RARITIES.reduce((sum, r) => sum + (loot[r] || 0), 0);
    setHtml(part('loot'),
      (total ? RARITIES.filter((r) => loot[r]).map((r) =>
        '<span class="stc-rarity-chip" style="color:' + RARITY_COLORS[r] + '">' + r[0].toUpperCase() + r.slice(1) + ' ' + fmt(loot[r]) + '</span>').join('') +
        '<div class="stc-row"><span class="stc-muted">Items total</span><span>' + fmt(total) + '</span></div>' : muted('No items yet')) +
      '<div class="stc-row"><span class="stc-muted">Enemies fought</span><span>' + fmt(session.fought || 0) +
        (session.enemiesMet ? muted(' of ' + fmt(session.enemiesMet) + ' met') : '') + '</span></div>');

    const boosts = activeBoosts();
    setHtml(part('boosts'), boosts && boosts.length
      ? boosts.map((b) => '<div class="stc-row"><span>' + escapeHtml(b.name) + '</span><span class="stc-ready">+' + b.value + '%</span></div>').join('')
      : muted('None'));

    renderHistory(part('history'));
  }

  function renderHistory(el) {
    const history = load(KEY.history, []);
    const signature = JSON.stringify(history.slice(0, 8).map((s) => s.start)) + history.length;
    if (signature === historyDrawn) return;
    historyDrawn = signature;
    el.innerHTML = history.length ? history.slice(0, 8).map(function (s) {
      const mins = Math.max(1, Math.round((s.end - s.start) / MIN));
      return '<div class="stc-row"><span class="stc-muted">' + new Date(s.start).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) +
        ' · ' + mins + 'm</span><span>' + fmt(s.steps) + ' steps · ' + short(s.exp) + ' EXP' +
        '<button class="stc-icon-btn" data-remove-session="' + s.start + '" title="Remove this session" style="margin-left:6px">×</button></span></div>';
    }).join('') + (history.length > 8 ? '<div class="stc-note">' + (history.length - 8) + ' older sessions are in the CSV export.</div>' : '')
      : muted('Finished sessions show up here');
  }

  function renderTravelStrip(timers) {
    if (!stripEl) return;
    const info = levelInfo(timers);
    const boosts = activeBoosts() || [];
    const parts = [
      session.active ? '<span>Session <b>' + formatDuration(sessionDuration()) + '</b></span>' : '<span class="stc-muted">No session yet: take a step to start</span>',
      '<span>Steps <b>' + fmt(session.steps) + '</b></span>',
      '<span>EXP <b>' + short(sessionExp()) + '</b></span>',
      '<span>Gold <b>' + short(session.gold) + '</b></span>'
    ];
    if (info) {
      parts.push('<span>Lv ' + fmt(info.level) + '<span class="stc-bar"><div style="width:' + info.pct.toFixed(1) + '%"></div></span>' +
        (info.left <= 0 ? ready('Level up!') : info.steps ? '≈ <b>' + fmt(info.steps) + '</b> steps' : muted('…')) + '</span>');
    }
    if (boosts.length) parts.push('<span>' + boosts.map((b) => '<span class="stc-chip stc-ready">' + escapeHtml(b.name) + ' +' + b.value + '%</span>').join('') + '</span>');
    if (verifyShown) parts.push('<span class="stc-warn">⚠ Human check waiting</span>');
    setHtml(stripEl, parts.join(''));
  }

  // ---------------------------------------------------------------------------
  // Page cards (Home, Battle, Collections, Diamond Market)
  // ---------------------------------------------------------------------------
  function renderPageCard(timers, now) {
    if (!pageCard) return;
    const part = (name) => pageCard.querySelector('[data-c="' + name + '"]');
    const data = load(KEY.data, {});

    if (part('player')) {
      const p = data.player;
      setHtml(part('player'), p
        ? '<div class="stc-row"><span class="stc-muted">Level</span><span>' + fmt(p.level) + '</span></div>' +
          (p.gold !== null ? '<div class="stc-row"><span class="stc-muted">Gold</span><span>' + fmt(p.gold) + '</span></div>' : '') +
          (p.steps !== null ? '<div class="stc-row"><span class="stc-muted">Total steps</span><span>' + fmt(p.steps) + '</span></div>' : '') +
          (p.location ? '<div class="stc-row"><span class="stc-muted">Location</span><span>' + escapeHtml(p.location) + '</span></div>' : '')
        : muted('Needs your API key (⚙ in the Companion block)'));
    }
    if (part('job')) {
      const job = jobEarnings(timers.job, now);
      setHtml(part('job'), job
        ? '<div class="stc-row"><span class="stc-muted">Minutes worked</span><span>' + job.done + ' / ' + job.total + '</span></div>' +
          '<div class="stc-row"><span class="stc-muted">Gold</span><span>' + fmt(job.goldNow) + ' / ' + fmt(job.goldTotal) + '</span></div>' +
          '<div class="stc-row"><span class="stc-muted">EXP</span><span>' + fmt(job.expNow) + ' / ' + fmt(job.expTotal) + '</span></div>' +
          '<div class="stc-row"><span class="stc-muted">Skill EXP</span><span>' + fmt(job.skillNow) + ' / ' + fmt(job.skillTotal) + '</span></div>' +
          '<div class="stc-row"><span class="stc-muted">Ends</span><span>' + timerView('job', timers, now).compact + '</span></div>'
        : muted(timers.job && !timers.job.working ? 'Not working right now' : 'Not checked yet'));
    }
    if (part('skills')) {
      setHtml(part('skills'), Array.isArray(data.skills) && data.skills.length
        ? data.skills.map((s) => '<div class="stc-row"><span>' + escapeHtml(s.skill[0].toUpperCase() + s.skill.slice(1)) + '</span><span>Level ' + fmt(s.level) + '</span></div>').join('')
        : muted('Needs your API key'));
    }
    if (part('orphanage')) setHtml(part('orphanage'), renderOrphanage(data.orphanage));
    if (part('boss')) {
      const boss = timers.boss;
      if (boss && boss.name && !boss.none) {
        const hpPct = boss.maxHp ? Math.round((boss.hp / boss.maxHp) * 100) : null;
        setHtml(part('boss'), '<div class="stc-grid">' +
          '<div><div class="stc-row"><span>' + escapeHtml(boss.name) + '</span><span>' + (boss.level ? 'Level ' + fmt(boss.level) : '') + '</span></div>' +
          (boss.maxHp ? '<div class="stc-row"><span class="stc-muted">Health</span><span>' + short(boss.hp) + ' / ' + short(boss.maxHp) + ' (' + hpPct + '%)</span></div>' : '') + '</div>' +
          '<div><div class="stc-row"><span class="stc-muted">Starts</span><span>' + timerView('boss', timers, now).compact + '</span></div>' +
          '<div class="stc-row"><span class="stc-muted">Alert</span><span>' + (settings.alerts.boss ? 'On' : 'Off') + muted(' (🔔 in the Companion block)') + '</span></div></div></div>');
      } else {
        setHtml(part('boss'), muted(boss && boss.none ? 'No world boss is scheduled right now.' : 'Not checked yet.'));
      }
    }
    if (part('collection')) {
      const coll = load(KEY.collection, { names: [] });
      setHtml(part('collection'), coll.names.length
        ? '<div class="stc-row"><span class="stc-muted">Known items and collectables</span><span>' + fmt(coll.names.length) + '</span></div>' +
          '<div class="stc-row"><span class="stc-muted">Last full scan</span><span>' + (coll.scannedAt ? timeAgo(coll.scannedAt) : 'not yet') + '</span></div>' +
          '<div class="stc-row"><span class="stc-muted">Last change</span><span>' + timeAgo(coll.updatedAt) + '</span></div>'
        : muted(scanning ? 'Scanning\u2026' : 'Not scanned yet; the first scan starts by itself soon.'));
    }
    if (part('market')) {
      const m = data.market;
      let html;
      if (!settings.marketWatch) html = muted('Turn on watching to see the cheapest listings here.');
      else if (!m) html = muted(settings.apiKey ? 'Checking…' : 'Needs your API key');
      else {
        html = (m.listings.slice(0, 5).map((l, i) =>
          '<div class="stc-row"><span' + (i === 0 ? ' class="stc-ready"' : '') + '>' + fmt(l.price) + ' gold</span><span class="stc-muted">' + l.amount + '× · ' + escapeHtml(l.seller) + '</span></div>').join('') || muted('No listings')) +
          '<div class="stc-note">' + m.count + ' listings · checked ' + timeAgo(m.seenAt) + '</div>';
      }
      setHtml(part('market'), html);
    }
  }

  // "Tier 2" when a tier is active, otherwise how far the first one is.
  function orphanageShort(tiers) {
    if (!Array.isArray(tiers) || !tiers.length) return muted('\u2014');
    const level = orphanageLevel(tiers);
    const next = level.filling ? 'T' + level.fillingNumber + ' ' + (level.filling.percentage || 0).toFixed(level.active ? 0 : 1) + '%' : '';
    if (level.active) return (level.active >= 3 ? ready('Tier 3') : 'Tier ' + level.active) + (next ? muted(' (' + next + ')') : '');
    return muted(next ? 'None (' + next + ')' : 'None');
  }

  function renderOrphanage(tiers) {
    if (!Array.isArray(tiers) || !tiers.length) return muted('Not checked yet (opens by itself in the background)');
    const level = orphanageLevel(tiers);
    let html = '<div class="stc-row"><span class="stc-muted">Current level</span><span>' +
      (level.active ? (level.active >= 3 ? ready('Tier 3') : 'Tier ' + level.active) : 'No tier active') + '</span></div>';
    const active = tiers.filter((t) => t.is_active).pop();
    if (active && active.effects) html += '<div class="stc-note" style="margin-top:0">' + active.effects.map(escapeHtml).join(' \u00B7 ') + '</div>';
    if (level.filling) {
      const t = level.filling;
      html += '<div class="stc-row"><span>' + escapeHtml(t.tier.name) + ' goal</span><span>' + (t.percentage || 0).toFixed(1) + '%</span></div>' +
        '<div class="stc-bar"><div style="width:' + Math.min(100, t.percentage || 0) + '%"></div></div>' +
        '<div class="stc-row"><span class="stc-muted">Gold to go</span><span>' + short(t.target_remaining) + '</span></div>';
    }
    html += '<div class="stc-note">' + (settings.alerts.orphanage3 ? 'You\u2019ll get an alert when Tier 3 is active.' : 'Tier 3 alert is off (\uD83D\uDD15 in the Companion block).') + '</div>';
    return html;
  }

  // ---------------------------------------------------------------------------
  // Clicks on our parts of the page
  // ---------------------------------------------------------------------------
  document.addEventListener('pointerdown', function (e) {
    if (!e.target.closest('[data-time-toggle]')) return;
    e.preventDefault();
    e.stopPropagation();
    settings.timeMode = settings.timeMode === 'countdown' ? 'clock' : 'countdown';
    save(KEY.settings, settings);
  }, true);

  document.addEventListener('click', function (e) {
    const t = e.target;
    if (t.closest('[data-time-toggle]')) { e.preventDefault(); e.stopPropagation(); return; } // handled on pointerdown
    if (t.closest('[data-open-settings]')) { e.preventDefault(); openSettings(); return; }
    if (t.closest('.stc-side [data-side-fold]')) {
      e.preventDefault();
      settings.sideFolded = !settings.sideFolded;
      save(KEY.settings, settings);
      applySideFold();
      return;
    }
    if (t.closest('.stc-side [data-dock-toggle]')) {
      e.preventDefault();
      e.stopPropagation();
      if (!settings.chatPopup) { openSettings(); showToast('Turn on "Messages icon opens chat popup" first.'); return; }
      toggleChat();
      return;
    }
    if (t.closest('.stc-side [data-dock-private]') && settings.chatPopup) {
      e.preventDefault();
      e.stopPropagation();
      toggleChat('private');
      return;
    }
    const bell = t.closest('[data-bell]');
    if (bell) {
      e.preventDefault();
      settings.alerts[bell.dataset.bell] = !settings.alerts[bell.dataset.bell];
      save(KEY.settings, settings);
      return;
    }
    const points = t.closest('[data-points]');
    if (points && !points.dataset.editing) { e.preventDefault(); editTarget(points); return; }
    if (t.closest('[data-toggle-details]')) {
      settings.walkDetailsOpen = !settings.walkDetailsOpen;
      save(KEY.settings, settings);
      applyDetailsOpen();
      return;
    }
    if (t.closest('[data-end-session]')) {
      if (!session.active) return;
      if (!confirm('End this session and save it to Past sessions? Your next step starts a new one.')) return;
      endSession(Date.now());
      return;
    }
    if (t.closest('[data-export-csv]')) { exportHistory(); return; }
    const scan = t.closest('[data-scan]');
    if (scan) { scanCollection((message) => { scan.textContent = message; }); return; }
    const remove = t.closest('[data-remove-session]');
    if (remove) {
      if (!confirm('Remove this session from Past sessions? This can’t be undone.')) return;
      const start = Number(remove.dataset.removeSession);
      update(KEY.history, (h) => {
        const i = h.findIndex((x) => x.start === start);
        if (i !== -1) h.splice(i, 1);
      }, []);
      historyDrawn = null;
    }
  });

  // ---------------------------------------------------------------------------
  // Shift planner (Profession page, also inside the Profession popup)
  // ---------------------------------------------------------------------------
  // Asks what you want to wait for, then suggests a shift that ends just before, on time or just after it.
  const planners = [];

  function plannerOptions(timers, now) {
    const list = [];
    TIMERS.forEach(function (def) {
      if (def.id === 'job') return;
      const view = timerView(def.id, timers, now);
      if (!view.endsAt || view.endsAt <= now) return;
      let label = def.name;
      const t = timers[def.id];
      if ((def.id === 'energy' || def.id === 'qp') && t && t.max) {
        const target = pointsTarget(def.id, t.max);
        label = def.name + (target < t.max ? ' reaches ' + target : ' full (' + t.max + ')');
      }
      if (def.id === 'boss' && t && t.name) label = 'World boss: ' + t.name;
      list.push({ id: def.id, label: label, at: view.endsAt });
    });
    // Also "full" when you've set a lower alert target for EP or QP.
    ['energy', 'qp'].forEach(function (id) {
      const t = timers[id];
      if (!t || !t.max || pointsTarget(id, t.max) >= t.max || t.current >= t.max) return;
      const fullAt = nextRegenTick(t.seenAt) + (t.max - t.current - 1) * REGEN_MS;
      if (fullAt > now) list.push({ id: id + 'Full', label: (id === 'energy' ? 'Energy' : 'Quest Points') + ' full (' + t.max + ')', at: fullAt });
    });
    return list.sort((a, b) => a.at - b.at);
  }

  // Our look, inside a popup page too.
  function ensureStyle(doc) {
    if (doc !== document && !doc.getElementById('stc-style')) {
      const copy = doc.importNode(style, true);
      copy.id = 'stc-style';
      doc.head.appendChild(copy);
    }
  }

  function mountPlanner(doc, column) {
    if (!column || column.querySelector('.stc-planner')) return;
    ensureStyle(doc);
    const el = doc.createElement('div');
    el.className = GAME.card + ' stc-card stc-ui stc-planner';
    el.style.marginBottom = '16px';
    // Starts closed; click the title to open it.
    el.innerHTML = '<button type="button" class="stc-card-title stc-plan-toggle" data-plan-toggle style="margin-bottom:0">' +
        '<span class="' + GAME.title + '">Plan your shift</span><span data-plan-caret>▸</span>' +
        '<span class="stc-muted" style="font-size:11px;margin-left:auto">Companion</span></button>' +
      '<div data-plan-body style="display:none;margin-top:10px">' +
        '<div class="stc-row" style="justify-content:flex-start;gap:10px;flex-wrap:wrap">What do you want to wait for?' +
          '<select data-plan-target></select><input type="time" data-plan-time style="display:none"></div>' +
        '<div data-plan-head style="margin-top:10px"></div><div data-plan-rows style="margin-top:6px"></div>' +
        '<div data-plan-foot></div></div>';
    column.insertBefore(el, column.firstChild);
    const planner = { el: el, doc: doc, gd: readGameData(doc.documentElement.innerHTML), open: false, ep: null, epReadAt: 0, pending: null };
    el.querySelector('[data-plan-target]').addEventListener('change', function () {
      settings.planTarget = this.value;
      save(KEY.settings, settings);
      renderPlanner(planner);
    });
    el.querySelector('[data-plan-time]').addEventListener('change', function () {
      settings.planTime = this.value;
      save(KEY.settings, settings);
      renderPlanner(planner);
    });
    el.addEventListener('click', function (e) {
      if (e.target.closest('[data-plan-toggle]')) {
        planner.open = !planner.open;
        el.querySelector('[data-plan-body]').style.display = planner.open ? '' : 'none';
        el.querySelector('[data-plan-caret]').textContent = planner.open ? '▾' : '▸';
        el.querySelector('[data-plan-toggle]').style.marginBottom = '0';
        if (planner.open) renderPlanner(planner);
        return;
      }
      const pick = e.target.closest('[data-plan-pick]');
      if (pick) fillMinutes(planner, parseInt(pick.dataset.planPick, 10));
    });
    planners.push(planner);
  }

  // The game's own "minutes" box (inside its Start Working window).
  function minutesBox(doc) {
    const input = doc.querySelector('input[x-model="minutes"], input[name="minutes"]');
    if (!input) return null;
    let host = input;
    while (host && !host._x_dataStack) host = host.parentElement;
    const data = host && host._x_dataStack[0];
    return { input: input, data: data && 'minutes' in data ? data : null };
  }

  function setMinutes(box, minutes) {
    try {
      if (box.data) {
        box.data.minutes = minutes;
        if (typeof box.data.checkMinutes === 'function') box.data.checkMinutes(); // same as typing it in
      } else {
        box.input.value = minutes;
        box.input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } catch (err) { /* leave it as it was */ }
  }

  // Fills in the minutes only. Starting the shift stays your click: Start Working, then confirm.
  function fillMinutes(planner, minutes) {
    if (!(minutes > 0)) return;
    const box = minutesBox(planner.doc);
    if (!box) { showToast('Couldn’t find the game’s minutes box. Type ' + minutes + ' in yourself.'); return; }
    setMinutes(box, minutes);
    // The box sits in the Start Working window; fill it again when that window opens, in case it reset.
    planner.pending = box.input.offsetParent ? null : { minutes: minutes, until: Date.now() + 5 * MIN };
    renderPlanner(planner);
    showToast('Filled in ' + minutes + ' minutes. Press Start Working and confirm to begin.');
  }

  function renderPlanner(planner) {
    const el = planner.el;
    const doc = planner.doc;
    const now = Date.now();

    if (planner.pending) {
      const box = minutesBox(doc);
      if (now > planner.pending.until || !box) planner.pending = null;
      else if (box.input.offsetParent) {
        if (String(box.data ? box.data.minutes : box.input.value) !== String(planner.pending.minutes)) setMinutes(box, planner.pending.minutes);
        planner.pending = null;
      }
    }
    if (!planner.open) return;

    const timers = load(KEY.timers, {});
    const gd = planner.gd;
    const select = el.querySelector('[data-plan-target]');
    const timeInput = el.querySelector('[data-plan-time]');
    const head = el.querySelector('[data-plan-head]');
    const rowsEl = el.querySelector('[data-plan-rows]');
    const foot = el.querySelector('[data-plan-foot]');

    // Rebuild the choices only when they change, so the list doesn't jump while you use it.
    const options = plannerOptions(timers, now);
    const signature = options.map((o) => o.id + ':' + o.label).join('|');
    if (select.dataset.sig !== signature) {
      select.dataset.sig = signature;
      select.innerHTML = options.map((o) => '<option value="' + o.id + '">' + escapeHtml(o.label) + '</option>').join('') +
        '<option value="custom">A time I choose</option>';
      const wanted = settings.planTarget;
      select.value = wanted === 'custom' || options.some((o) => o.id === wanted) ? wanted : (options[0] ? options[0].id : 'custom');
    }
    timeInput.style.display = select.value === 'custom' ? '' : 'none';
    if (select.value === 'custom' && !timeInput.value && settings.planTime) timeInput.value = settings.planTime;

    let target = null;
    if (select.value === 'custom') {
      const m = (timeInput.value || '').match(/^(\d{1,2}):(\d{2})/);
      if (m) {
        const d = new Date();
        d.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
        if (d.getTime() <= now) d.setDate(d.getDate() + 1);
        target = d.getTime();
      }
    } else {
      const chosen = options.find((o) => o.id === select.value);
      target = chosen ? chosen.at : null;
    }
    if (!target) { setHtml(head, muted('Pick what you want to wait for, or a time.')); setHtml(rowsEl, ''); setHtml(foot, ''); return; }

    // A new shift can only start once the current one is over.
    const job = timers.job;
    const start = job && job.working && job.endsAt > now ? job.endsAt : now;
    const minutesUntil = (target - start) / MIN;
    const block = gd['profession.duration.wait_length_in_minutes'] || 10;   // energy is paid per started block
    const costPerBlock = gd['profession.energy_cost'] || 1;
    const maxMinutes = Math.floor((gd['profession.duration.max_wait_length'] || 86400000) / MIN);
    const perMin = { exp: gd['profession.rewards.player_experience'] || 0, gold: gd['profession.rewards.gold'] || 0 };

    // Your energy: read from this page (the "Energy Points" box), otherwise the Companion's estimate.
    if (now - planner.epReadAt > 2000) {
      planner.epReadAt = now;
      const read = readPoints('Energy Points', doc);
      if (read) {
        planner.ep = { current: read.current, max: read.max, seenAt: now };
        if (!settings.apiKey && doc !== document) setTimer('energy', read);
      }
    }
    const ep = planner.ep || timers.energy || null;
    const ticksBy = (from, at) => at >= nextRegenTick(from) ? Math.floor((at - nextRegenTick(from)) / REGEN_MS) + 1 : 0;
    // +1 at every 5-minute mark, counted up to when the shift can start.
    const energyAtStart = ep ? Math.min(ep.max, ep.current + ticksBy(ep.seenAt, start)) : null;
    const maxAffordable = energyAtStart === null ? maxMinutes : Math.min(maxMinutes, Math.floor(energyAtStart / costPerBlock) * block);

    setHtml(head, '<div class="stc-row"><span class="stc-muted">Ready</span><span>' + clockTime(target) + muted(' (' + formatDuration(target - now) + ' from now)') + '</span></div>' +
      '<div class="stc-row"><span class="stc-muted">' + (start > now ? 'Energy when your shift ends' : 'Your energy') + '</span><span>' +
        (energyAtStart === null ? muted('not known yet') : energyAtStart + (ep.max ? ' / ' + ep.max : '') + muted(' · up to ' + maxAffordable + ' min')) + '</span></div>' +
      (start > now ? '<div class="stc-note" style="margin-top:0">You’re working until ' + clockTime(start) + ', so these count from then.</div>' : ''));

    if (minutesUntil < 1) { setHtml(rowsEl, muted('That’s ready before you could start a shift.')); setHtml(foot, ''); return; }
    if (maxAffordable < 1) { setHtml(rowsEl, '<span class="stc-warn">Not enough energy for a shift yet.</span>'); setHtml(foot, ''); return; }

    const choices = [];
    const before = Math.floor(minutesUntil / block) * block;
    const onTime = Math.ceil(minutesUntil); // ends within a minute after it's ready, never before
    const after = Math.ceil(minutesUntil / block) * block;
    if (before >= block && before !== onTime) choices.push({ name: 'Just before', minutes: before });
    choices.push({ name: 'On time', minutes: onTime });
    if (after !== onTime) choices.push({ name: 'Just after', minutes: after });
    choices.forEach((c) => { c.minutes = Math.min(maxMinutes, Math.max(1, c.minutes)); });
    // When your energy can't cover them all, also offer the longest shift you can pay for.
    if (choices.some((c) => c.minutes > maxAffordable) && !choices.some((c) => c.minutes === maxAffordable)) {
      choices.push({ name: 'Most you can afford', minutes: maxAffordable });
      choices.sort((a, b) => a.minutes - b.minutes);
    }

    const rows = choices.map(function (c) {
      const minutes = c.minutes;
      const ends = start + minutes * MIN;
      const diffMs = ends - target;
      const diff = diffMs >= 0 && diffMs < MIN ? 0 : Math.round(diffMs / MIN);
      const energy = Math.ceil(minutes / block) * costPerBlock;
      const notEnough = minutes > maxAffordable;
      return '<div class="stc-plan-row' + (notEnough ? ' stc-plan-off' : '') + '"' +
          (notEnough ? ' title="Not enough energy"' : ' data-plan-pick="' + minutes + '" title="Fill in ' + minutes + ' minutes"') + '>' +
        '<span><b>' + minutes + ' min</b><br>' + muted(c.name) + '</span>' +
        '<span>ends ' + clockTime(ends) + '<br>' + muted(diff === 0 ? 'right on time' : Math.abs(diff) + ' min ' + (diff < 0 ? 'before' : 'after')) + '</span>' +
        '<span' + (notEnough ? ' class="stc-warn"' : '') + '>' + energy + ' energy<br>' + muted(notEnough ? 'you’ll have ' + energyAtStart : 'per ' + block + ' min: ' + costPerBlock) + '</span>' +
        '<span>' + (perMin.exp ? short(minutes * perMin.exp) + ' EXP' : '') + '<br>' + muted(perMin.gold ? short(minutes * perMin.gold) + ' gold' : '') + '</span>' +
        '<span class="stc-plan-use">' + (notEnough ? '' : 'Fill in') + '</span></div>';
    }).join('');
    setHtml(rowsEl, rows);
    const capped = minutesUntil > maxMinutes ? '<div class="stc-note">The longest shift is ' + maxMinutes + ' minutes, so it can’t reach that time in one go.</div>' : '';
    setHtml(foot, capped + '<div class="stc-note">Click a row to fill its minutes into the game’s box, then press Start Working and confirm. ' +
      'Energy is paid per started ' + block + ' minutes, so “Just before” wastes none.</div>');
  }

  // ---------------------------------------------------------------------------
  // Quest helper (Quests page, also inside the Quests popup)
  // ---------------------------------------------------------------------------
  // Shows the quest you're closest to finishing. Performing it is up to you.
  const questHelpers = [];

  function mountQuestHelper(doc, column) {
    if (!column || column.querySelector('.stc-quests')) return;
    ensureStyle(doc);
    const el = doc.createElement('div');
    el.className = GAME.card + ' stc-card stc-ui stc-quests';
    el.style.marginBottom = '16px';
    el.innerHTML = '<div class="stc-card-title"><span class="' + GAME.title + '">Closest to finishing</span>' +
      '<span class="stc-muted" style="font-size:11px;margin-left:auto">Companion</span></div><div data-q></div>' +
      '<div class="stc-row" style="margin-top:10px;justify-content:flex-start;gap:10px">' + muted('Sort the list below:') +
        '<span class="stc-seg"><button type="button" data-q-sort="left">Fewest left first</button>' +
        '<button type="button" data-q-sort="game">Game order</button></span></div>';
    column.insertBefore(el, column.firstChild);
    const helper = { el: el, doc: doc, gd: readGameData(doc.documentElement.innerHTML) };
    el.addEventListener('click', function (e) {
      const show = e.target.closest('[data-q-show]');
      if (show) { e.preventDefault(); showQuest(doc, show.dataset.qShow); return; }
      const sort = e.target.closest('[data-q-sort]');
      if (sort) {
        settings.questSort = sort.dataset.qSort;
        save(KEY.settings, settings);
        renderQuestHelper(helper);
      }
    });
    questHelpers.push(helper);
    renderQuestHelper(helper);
  }

  // The live quest list on the page (it updates as you perform), otherwise what the page started with.
  function questData(helper) {
    for (const node of helper.doc.querySelectorAll('[x-data]')) {
      const d = node._x_dataStack && node._x_dataStack[0];
      if (d && Array.isArray(d.expeditions)) return { list: d.expeditions, qp: d.quest_points, maxQp: d.max_quest_points };
    }
    const gd = helper.gd;
    return { list: gd['expedition.expeditions'] || [], qp: gd['expedition.user.quest_points'], maxQp: gd['expedition.user.max_quest_points'] };
  }

  function closestQuests(list) {
    return list
      .filter((q) => !q.is_completed && Number(q.success_chance) > 0 && q.progress && q.progress.required)
      .map((q) => ({
        title: q.title, chance: Number(q.success_chance),
        current: q.progress.current || 0, required: q.progress.required,
        left: q.progress.required - (q.progress.current || 0)
      }))
      .filter((q) => q.left > 0)
      .sort((a, b) => a.left - b.left || b.chance - a.chance);
  }

  // Reorders the game's quest list on screen only (CSS order); the game's own data is left alone.
  function sortQuestList(doc) {
    const template = [...doc.querySelectorAll('template')].find((t) => /in\s+filtered_expeditions/.test(t.getAttribute('x-for') || ''));
    if (!template || !template.parentElement) return;
    const items = [...template.parentElement.children].filter((el) => el !== template && el._x_dataStack && el._x_dataStack[0].expedition);
    let ranked = items;
    if (settings.questSort === 'left') {
      const group = (q) => q.is_completed ? 2 : Number(q.success_chance) > 0 ? 0 : 1; // unlocked, then locked, then done
      const left = (q) => q.progress && q.progress.required ? q.progress.required - (q.progress.current || 0) : Infinity;
      ranked = items.slice().sort(function (a, b) {
        const qa = a._x_dataStack[0].expedition;
        const qb = b._x_dataStack[0].expedition;
        return group(qa) - group(qb) || left(qa) - left(qb);
      });
    }
    ranked.forEach(function (el, i) {
      const order = settings.questSort === 'left' ? String(i) : '';
      if (el.style.order !== order) el.style.order = order;
    });
  }

  function renderQuestHelper(helper) {
    helper.el.querySelectorAll('[data-q-sort]').forEach((b) => b.classList.toggle('on', b.dataset.qSort === (settings.questSort || 'game')));
    sortQuestList(helper.doc);
    const out = helper.el.querySelector('[data-q]');
    const data = questData(helper);
    const quests = closestQuests(data.list);
    if (!quests.length) { setHtml(out, muted('No unlocked quests left to finish.')); return; }
    const timers = load(KEY.timers, {});
    const qp = typeof data.qp === 'number' ? { current: data.qp, max: data.maxQp } : timers.qp;
    const q = quests[0];
    const needed = Math.ceil(q.left / (q.chance / 100)); // about this many tries, at its success chance
    let qpLine = '';
    if (qp && typeof qp.current === 'number') {
      if (qp.current >= needed) qpLine = ready('Enough QP to finish it now') + muted(' (' + qp.current + ' QP)');
      else if (qp.max && needed <= qp.max) {
        const seenAt = qp.seenAt || Date.now();
        const at = nextRegenTick(seenAt) + (needed - qp.current - 1) * REGEN_MS;
        qpLine = 'You have ' + qp.current + ' QP' + muted(' · enough at ' + clockTime(at));
      } else qpLine = 'You have ' + qp.current + ' QP' + muted(' · needs more than one full bar' + (qp.max ? ' (' + qp.max + ')' : ''));
    }
    const pct = Math.min(100, (q.current / q.required) * 100);
    setHtml(out,
      '<button type="button" class="stc-quest-top" data-q-show="' + escapeHtml(q.title) + '" title="Open this quest">' +
        '<span class="stc-row"><b>' + escapeHtml(q.title) + '</b><span>' + fmt(q.left) + ' left</span></span>' +
        '<span class="stc-bar"><span style="display:block;height:100%;width:' + pct + '%"></span></span>' +
        '<span class="stc-row"><span class="stc-muted">' + fmt(q.current) + ' / ' + fmt(q.required) + ' · ' + q.chance + '% success</span>' +
          '<span class="stc-muted">about ' + fmt(needed) + ' QP</span></span></button>' +
      (qpLine ? '<div class="stc-row" style="margin-top:6px"><span></span><span>' + qpLine + '</span></div>' : '') +
      (quests.length > 1 ? '<div class="stc-note">Next: ' + quests.slice(1, 3).map((n) =>
        '<a href="#" data-q-show="' + escapeHtml(n.title) + '">' + escapeHtml(n.title) + '</a> (' + fmt(n.left) + ' left)').join(' · ') + '</div>' : '') +
      '<div class="stc-note">Click a quest to open it.</div>');
  }

  // Opens the game's own quest window for this quest, the same way clicking it in the list does
  // (it only opens the window; pressing Perform stays your click).
  function showQuest(doc, title) {
    const win = doc.defaultView;
    const template = [...doc.querySelectorAll('template')].find((t) => /in\s+filtered_expeditions/.test(t.getAttribute('x-for') || ''));
    const items = template ? [...template.parentElement.children].filter((el) => el !== template && el._x_dataStack && el._x_dataStack[0].expedition) : [];
    const item = items.find((el) => el._x_dataStack[0].expedition.title === title);
    let quest = item ? item._x_dataStack[0].expedition : null;
    if (!quest) { // not in the list's current tab: take it from the full quest list
      for (const node of doc.querySelectorAll('[x-data]')) {
        const d = node._x_dataStack && node._x_dataStack[0];
        if (d && Array.isArray(d.expeditions)) { quest = d.expeditions.find((q) => q.title === title) || null; break; }
      }
    }
    if (!quest || !win) { showToast('Couldn\u2019t open that quest. Find it in the list below.'); return; }
    const from = item || (template && template.parentElement) || doc.body;
    const options = { bubbles: true, composed: true, cancelable: true };
    from.dispatchEvent(new win.CustomEvent('set-expedition-data', Object.assign({ detail: { expedition: quest } }, options)));
    from.dispatchEvent(new win.CustomEvent('open-modal', Object.assign({ detail: 'perform-expedition' }, options)));
  }

  // ---------------------------------------------------------------------------
  // Everything that updates several times a second
  // ---------------------------------------------------------------------------
  let questTick = 0;
  function render() {
    const timers = load(KEY.timers, {});
    const now = Date.now();
    // Ended cooldowns you haven't seen yet; hovering the Companion block counts as seeing them.
    const unseenIds = unseenCooldownIds(timers, now, sideHover);
    renderSidebar(timers, now, unseenIds);
    renderUnread();
    renderTravelStrip(timers);
    renderWalkCard(timers);
    renderPageCard(timers, now);
    for (let i = planners.length - 1; i >= 0; i--) {
      if (!planners[i].el.isConnected) planners.splice(i, 1);
      else renderPlanner(planners[i]);
    }
    if (++questTick % 4 === 0) {
      for (let i = questHelpers.length - 1; i >= 0; i--) {
        if (!questHelpers[i].el.isConnected) questHelpers.splice(i, 1);
        else renderQuestHelper(questHelpers[i]);
      }
    }
  }

  // NEW badges next to item names (inventory pages).
  function markCollection() {
    if (!settings.collectionMarks || !PATH.startsWith('/inventory')) return;
    const names = collectionNames();
    if (!names.size) return;
    document.querySelectorAll('main tr span[class*="-item"]:not([data-stc])').forEach(function (span) {
      span.setAttribute('data-stc', '1');
      if (names.has(span.textContent.trim().toLowerCase())) return; // only mark what's new, to keep the list calm
      const badge = document.createElement('span');
      badge.className = 'stc-coll new';
      badge.textContent = 'NEW';
      badge.title = 'Not in your collection yet';
      span.after(badge);
    });
  }

  // ---------------------------------------------------------------------------
  // Giving items away (Town Supply Requests and the Item Dumping Grounds)
  // ---------------------------------------------------------------------------
  // The game won't take items that are sold in the shop, and you don't want to give away
  // something that isn't in your collection yet. Their Contribute / Throw buttons get greyed out.
  const SHOP_ITEMS = new Set([
    'Simple Dagger', 'Bootleg T-Shirt', 'Some Geezers Bow', 'Leather Armour', 'Generic Shirt', 'Cheese',
    'Special Carrot', 'Pie', 'Mushroom of Energy +1', 'Delicious Pie', 'Tree', 'Succulent Leaf', 'Bootleg Cheese',
    'Mortems Potion', 'Mushroom of Energy +1 (Untradable)', 'Rat', 'Boar', 'Golem',
    'Rusty Axe', 'Weak Axe', 'Rusty Fishing Rod', 'Weak Fishing Rod', 'Rusty Shovel', 'Weak Shovel',
    'Rusty Pickaxe', 'Weak Pickaxe', 'Strong Axe', 'Thicc Axe', 'Almost Legendary Axe',
    'Strong Fishing Rod', 'Super Fishing Rod', 'Epic Fishing Rod', 'Strong Shovel', 'Super Shovel', 'Epic Shovel',
    'Strong Pickaxe', 'Viking Pickaxe', 'Super Duper Pickaxe'
  ].map((n) => n.toLowerCase()));

  // Pages where you pick an item to give away.
  function isGivingPage(loc) {
    if (loc.pathname.startsWith('/item-dump/items')) return true;
    return /^\/inventory\/(items|storage)/.test(loc.pathname) && new URLSearchParams(loc.search).has('town_supply_contribution');
  }

  const guardedDocs = [];
  function watchGivingPage(doc, loc) {
    if (!isGivingPage(loc) || guardedDocs.includes(doc)) return;
    guardedDocs.push(doc);
    ensureStyle(doc);
    // "Use anyway" for an item the Companion thinks isn't collected (some items can't be collected at all).
    doc.addEventListener('click', function (e) {
      const allow = e.target.closest('[data-stc-allow]');
      if (!allow) return;
      e.preventDefault();
      e.stopPropagation();
      update(KEY.allowGive, (list) => { if (!list.includes(allow.dataset.stcAllow)) list.push(allow.dataset.stcAllow); }, []);
      guardItems(doc);
    }, true);
    guardItems(doc);
  }

  function guardItems(doc) {
    if (!settings.guardGiving) return;
    const names = collectionNames();
    const allowed = new Set(load(KEY.allowGive, []));
    const learned = [];
    doc.querySelectorAll('tr[id^="item-"]').forEach(function (row) {
      const nameEl = row.querySelector('span[class*="-item"]');
      const name = nameEl ? nameEl.textContent.trim() : '';
      if (!name) return;
      const key = name.toLowerCase();
      const text = row.textContent;
      // The game shows "You have collected this item" (the green checkmark) on collected items.
      const collectedHere = /You have collected this item/.test(text);
      if (collectedHere && !names.has(key)) learned.push(name);
      const collectable = [...row.querySelectorAll('button')].some((b) => /Add to Collection/.test(b.textContent)) ||
        [...row.querySelectorAll('*')].some((el) => el.children.length === 0 && el.textContent.trim() === 'Collectable');
      let reason = null;
      if (SHOP_ITEMS.has(key)) reason = 'shop';
      else if (collectable && !collectedHere && !names.has(key) && !allowed.has(key)) reason = 'collection';

      row.querySelectorAll('a, button').forEach(function (control) {
        if (!/^(Throw|Contribute)$/.test(control.textContent.trim())) return;
        const note = control.nextElementSibling && control.nextElementSibling.hasAttribute('data-stc-note') ? control.nextElementSibling : null;
        if (!reason) {
          if (control.classList.contains('stc-blocked')) {
            control.classList.remove('stc-blocked');
            control.removeAttribute('tabindex');
            control.removeAttribute('aria-disabled');
          }
          if (note) note.remove();
          return;
        }
        if (!control.classList.contains('stc-blocked')) {
          control.classList.add('stc-blocked');
          control.setAttribute('tabindex', '-1');
          control.setAttribute('aria-disabled', 'true');
        }
        if (!note || note.dataset.stcNote !== reason) {
          if (note) note.remove();
          const span = doc.createElement('span');
          span.className = 'stc-ui stc-give-note';
          span.setAttribute('data-stc-note', reason);
          span.innerHTML = reason === 'shop'
            ? 'Shop item: not accepted'
            : 'Not in your collection yet · <a href="#" data-stc-allow="' + escapeHtml(key) + '">use anyway</a>';
          control.after(span);
        }
      });
      // Multi-select boxes too, so a blocked item can't slip in with others.
      row.querySelectorAll('input[type="checkbox"]').forEach(function (box) {
        if (reason && !box.disabled) { box.checked = false; box.disabled = true; box.dataset.stcBlocked = '1'; }
        if (!reason && box.dataset.stcBlocked) { box.disabled = false; delete box.dataset.stcBlocked; }
      });
    });
    if (learned.length) addToCollection(learned);
  }

  function guardAllGivingPages() {
    for (let i = guardedDocs.length - 1; i >= 0; i--) {
      const doc = guardedDocs[i];
      if (!doc.defaultView) guardedDocs.splice(i, 1); // popup was closed
      else guardItems(doc);
    }
  }

  // ---------------------------------------------------------------------------
  // Chat popup: the Messages icon in the game's top bar opens Global and Private chat here
  // ---------------------------------------------------------------------------
  const dock = document.createElement('div');
  dock.id = 'stc-dock';
  dock.innerHTML =
    '<div id="stc-dock-head">' +
      '<button id="stc-dock-back" title="Back to all private chats" style="display:none">\u2039 Chats</button>' +
      '<button data-dock-tab="global">Global</button>' +
      '<button data-dock-tab="private">Private<span class="stc-unread" id="stc-dock-unread" style="display:none"></span></button>' +
      '<button class="stc-dock-close" title="Close (Esc or Alt+M)">\u00D7</button>' +
    '</div>' +
    '<div id="stc-dock-body"><div id="stc-dock-hint" style="display:none"></div></div>';
  document.body.appendChild(dock);

  let privateFrame = null;
  let globalFrame = null;
  let privatePath = '';   // the page currently open in the Private tab

  // Which tab you used last and which private chat you had open.
  function chatState() { return load(KEY.dock, { tab: 'private', privateUrl: '/messages/inbox' }); }
  function setChatState(changes) { update(KEY.dock, (d) => Object.assign(d, changes), { tab: 'private', privateUrl: '/messages/inbox' }); }

  // Classic layout: icons in the top bar. New layout: the icon row under your name in the left menu.
  const MESSAGES_LINK = 'a[href*="/messages/inbox"], a[href*="/messages/view/chat"]';
  function isGameIcon(a) {
    return !a.closest('.stc-ui, #stc-dock, #stc-notes, #stc-page-pop') && isVisible(a) &&
      (a.getBoundingClientRect().top < 64 || !!a.closest('aside'));
  }

  function findMessagesIcon() {
    return [...document.querySelectorAll(MESSAGES_LINK)].find(isGameIcon);
  }

  // Popups open beside the icon: below it in the top bar, to the right of the left menu in the new layout.
  function placeBesideIcon(win, icon, fromRight) {
    const aside = icon && icon.closest('aside');
    if (aside) {
      const r = icon.getBoundingClientRect();
      win.style.left = Math.round(aside.getBoundingClientRect().right + 12) + 'px';
      win.style.right = 'auto';
      win.style.top = Math.max(8, Math.round(r.top)) + 'px';
    } else {
      const r = icon ? icon.getBoundingClientRect() : { right: window.innerWidth - fromRight };
      win.style.left = '';
      win.style.top = '';
      win.style.right = Math.max(8, window.innerWidth - r.right - fromRight) + 'px';
    }
  }

  // The game's global chat is a page of its own; its address is written into every game page.
  function globalChatUrl() {
    const m = document.documentElement.innerHTML.match(/'(\/chat\/public\?[^']+)'/);
    return m ? m[1].replace(/&amp;/g, '&') : null;
  }

  function openChat(tab) {
    closeNotes();
    if (typeof closePagePopup === 'function' && pagePop) closePagePopup();
    placeBesideIcon(dock, findMessagesIcon(), 60);
    dock.classList.add('open');
    showChatTab(tab || chatState().tab);
  }

  function closeChat() { dock.classList.remove('open'); }

  function toggleChat(tab) {
    if (dock.classList.contains('open') && (!tab || chatState().tab === tab)) closeChat();
    else openChat(tab);
  }

  function showChatTab(tab) {
    setChatState({ tab: tab });
    if (tab === 'global') ensureGlobalFrame();
    if (tab === 'private') ensurePrivateFrame(chatState().privateUrl || '/messages/inbox');
    syncChat();
  }

  dock.addEventListener('click', function (e) {
    const tabBtn = e.target.closest('[data-dock-tab]');
    if (tabBtn) showChatTab(tabBtn.dataset.dockTab);
    if (e.target.closest('.stc-dock-close')) closeChat();
    if (e.target.closest('#stc-dock-back') && privateFrame) {
      privateFrame.src = '/messages/inbox';
      setChatState({ privateUrl: '/messages/inbox' });
    }
  });

  // Catch clicks on the game's Messages icon before the browser follows the link.
  document.addEventListener('click', function (e) {
    if (!settings.chatPopup) return;
    const icon = e.target.closest(MESSAGES_LINK);
    if (icon && icon === findMessagesIcon()) {
      e.preventDefault();
      e.stopPropagation();
      toggleChat();
      return;
    }
    // Clicking anywhere else closes it.
    if (dock.classList.contains('open') && !e.target.closest('#stc-dock, .stc-side')) closeChat();
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dock.classList.contains('open')) closeChat();
  });

  // Things that should work the same inside the chat pages.
  function wireFrame(doc) {
    catchCheckpoint(doc.defaultView);
    doc.addEventListener('keydown', onShortcut); // Alt+M
    doc.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeChat(); });
  }

  function ensureGlobalFrame() {
    if (globalFrame) return;
    const url = globalChatUrl();
    if (!url) return; // shows a hint instead (see syncChat)
    globalFrame = document.createElement('iframe');
    globalFrame.title = 'Global chat';
    globalFrame.src = url;
    globalFrame.addEventListener('load', function () {
      try { wireFrame(globalFrame.contentDocument); } catch (err) { /* not readable */ }
    });
    $('stc-dock-body').appendChild(globalFrame);
  }

  // Game pages shown inside our column or popup: hide the game's menus so only the content shows.
  function hideGameChrome(doc) {
    catchCheckpoint(doc.defaultView); // every page shown in one of our popups
    const css = doc.createElement('style');
    css.textContent =
      '.md\\:flex-shrink-0, nav.shadow-sm, footer, #show_hide_chat_btn, #chatBox, .bg-indigo-600.text-sm { display: none !important; }' +
      'main { padding-top: 0 !important; } .web-app-container { padding-top: 4px !important; }' +
      // New layout: its left menu, the menu button and the dark overlay behind the menu.
      'aside, .h-screen button.fixed.rounded-full, .h-screen .fixed.inset-0.lg\\:hidden { display: none !important; }' +
      'main { padding-left: 0 !important; }';
    doc.head.appendChild(css);
  }

  // ---------------------------------------------------------------------------
  // Notifications popup: the bell in the game's top bar opens your notifications here
  // ---------------------------------------------------------------------------
  const notes = document.createElement('div');
  notes.id = 'stc-notes';
  notes.innerHTML =
    '<div id="stc-notes-head"><span>Notifications</span>' +
      '<span><a href="/events" id="stc-notes-full">Full page</a>' +
      '<button class="stc-notes-close" title="Close (Esc)">×</button></span></div>' +
    '<div id="stc-notes-body"></div>';
  document.body.appendChild(notes);

  function findBell() {
    return [...document.querySelectorAll('a[href$="/events"]')].find(isGameIcon);
  }

  function openNotes() {
    if (typeof closeChat === 'function') closeChat();
    placeBesideIcon(notes, findBell(), 40);
    // Fresh copy of the page every time you open it.
    const frame = document.createElement('iframe');
    frame.title = 'Notifications';
    frame.src = '/events';
    frame.addEventListener('load', function () {
      try {
        const doc = frame.contentDocument;
        hideGameChrome(doc);
        clearBellBadge(); // you've now seen them, like when you visit the Notifications page
        // Links to other pages (a profile, a guild) open in the main window; filters stay in the popup.
        doc.addEventListener('click', function (e) {
          const a = e.target.closest('a[href]');
          if (!a) return;
          const href = a.getAttribute('href');
          if (/^(javascript:|#)/i.test(href)) return;
          const url = new URL(href, location.origin);
          if (url.origin !== location.origin || url.pathname === '/events') return;
          e.preventDefault();
          const def = popupFor(url);
          if (def) openPagePopup(url, def, a.textContent.replace(/\s+/g, ' ').trim().slice(0, 40));
          else location.href = withoutNewPage(url.href);
        });
        doc.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeNotes(); });
      } catch (err) { /* page not readable: leave it as is */ }
    });
    const body = $('stc-notes-body');
    body.innerHTML = '';
    body.appendChild(frame);
    notes.classList.add('open');
  }

  // The count on the bell is only drawn when a page loads, so remove it here once you've seen your notifications.
  function clearBellBadge() {
    const bell = findBell();
    if (!bell) return;
    // New layout: the count sits next to the link, inside the same small box.
    const scope = bell.closest('aside') ? (bell.closest('.relative') || bell) : bell;
    scope.querySelectorAll('span').forEach(function (span) {
      if (!span.classList.contains('sr-only') && /^\d+\+?$/.test(span.textContent.trim())) span.remove();
    });
  }

  function closeNotes() {
    notes.classList.remove('open');
    $('stc-notes-body').innerHTML = '';
  }

  // Catch clicks on the game's bell before the browser follows the link.
  document.addEventListener('click', function (e) {
    if (!settings.notificationsPopup) return;
    const bell = e.target.closest('a[href$="/events"]');
    if (bell && bell === findBell()) {
      e.preventDefault();
      e.stopPropagation();
      if (notes.classList.contains('open')) closeNotes(); else openNotes();
      return;
    }
    if (e.target.closest('.stc-notes-close')) { closeNotes(); return; }
    // Clicking anywhere else closes it.
    if (notes.classList.contains('open') && !e.target.closest('#stc-notes')) closeNotes();
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && notes.classList.contains('open')) closeNotes();
  });

  // ---------------------------------------------------------------------------
  // Game pages in a popup, so the Travel page can stay your main page
  // ---------------------------------------------------------------------------
  // Popup titles for common pages. Any other page shows its own title once it has loaded.
  const PAGE_NAMES = [
    { path: '/inventory', name: 'Inventory' }, { path: '/battle', name: 'Battle' }, { path: '/quests', name: 'Quests' },
    { path: '/profession', name: 'Profession' }, { path: '/crafting', name: 'Crafting' }, { path: '/tasks', name: 'Tasks' },
    { path: '/user/character', name: 'Your Character' }, { path: '/character', name: 'Your Character' },
    { path: '/collection/', name: 'Collections' }, { path: '/npcs/', name: 'Battle' },
    { path: '/horse-and-carriage', name: 'Change Location' }, { path: '/i-am-not-a-bot', name: 'Human check', newTabLink: true }
  ];

  // Pages that should never open in the popup.
  const NEVER_POPUP = /^\/(travel\/?$|logout|login|register)/;

  const pagePop = document.createElement('div');
  pagePop.id = 'stc-page-pop';
  pagePop.innerHTML =
    '<div id="stc-page-box"><div id="stc-page-head"><span id="stc-page-title"></span>' +
      '<a id="stc-page-full" href="#">Open full page</a>' +
      '<button class="stc-page-close" title="Close (Esc)">\u00D7</button></div>' +
    '<div id="stc-page-body"></div></div>';
  document.body.appendChild(pagePop);

  // Every game page opens in the popup, except Travel (your main page), logging out,
  // and the pages that have popups of their own (Messages, Notifications).
  function popupFor(url) {
    if (!settings.pagePopups || url.origin !== location.origin) return null;
    if (settings.popupsOnlyOnTravel && !isTravelPage) return null;
    const path = url.pathname;
    if (NEVER_POPUP.test(path) || /\.(png|jpe?g|gif|svg|webp|css|js|json|csv|zip)$/i.test(path)) return null;
    if (settings.chatPopup && /^\/messages\/(inbox|view\/chat)/.test(path)) return null;
    if (settings.notificationsPopup && path === '/events') return null;
    const known = PAGE_NAMES.find((p) => path === p.path || path.startsWith(p.path.endsWith('/') ? p.path : p.path + '/'));
    return known || { name: null };
  }

  function openPagePopup(url, def, linkText) {
    closeNotes();
    closeChat();
    closeSettings();
    $('stc-page-title').textContent = def.name || linkText || 'SimpleMMO';
    const address = withoutNewPage(url.href);
    $('stc-page-full').href = address;
    const frame = document.createElement('iframe');
    frame.title = def.name;
    frame.src = address;
    frame.addEventListener('load', function () {
      try {
        const doc = frame.contentDocument;
        const where = frame.contentWindow.location;
        // Going back to Travel from inside the popup just closes it.
        if (/^\/travel\/?$/.test(where.pathname)) { closePagePopup(); return; }
        if ((where.pathname.startsWith('/profession') || where.pathname.startsWith('/quests')) && settings.showPageCards) {
          const container = doc.querySelector('.web-app-container');
          const column = container && [...container.children].find((c) => /max-w-/.test(c.className) && c.textContent.trim());
          if (where.pathname.startsWith('/profession')) mountPlanner(doc, column);
          else mountQuestHelper(doc, column);
        }
        // Show the page's own title, and keep "Open full page" pointing at where you are now.
        const own = (doc.title || '').replace(/\s*\|\s*SimpleMMO\s*$/i, '').trim();
        if (own && !/^SimpleMMO$/i.test(own)) $('stc-page-title').textContent = own;
        $('stc-page-full').href = withoutNewPage(where.href);
        noteBattle(where.pathname);
        watchGivingPage(doc, where);
        hideGameChrome(doc);
        doc.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePagePopup(); });
        doc.addEventListener('keydown', onShortcut);
        // Keep your timers up to date from what the popup shows.
        if (SOURCES[where.pathname]) scheduleSource(where.pathname, SOURCES[where.pathname](doc.documentElement.innerHTML));
      } catch (err) { /* page not readable: leave it as is */ }
    });
    const body = $('stc-page-body');
    body.innerHTML = '';
    body.appendChild(frame);
    pagePop.classList.add('open');
  }

  function closePagePopup() {
    pagePop.classList.remove('open');
    $('stc-page-body').innerHTML = '';
  }

  pagePop.addEventListener('click', function (e) {
    if (e.target.closest('.stc-page-close') || e.target === pagePop) closePagePopup(); // × or the dark area around it
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && pagePop.classList.contains('open')) closePagePopup();
  });

  // Catch clicks on links to these pages (the game's menu, our Companion section) before the browser follows them.
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return; // Ctrl+click still opens a tab
    const a = e.target.closest('a[href]');
    if (!a || a.closest('#stc-page-pop, #stc-dock, #stc-notes')) return;
    let url;
    try { url = new URL(a.getAttribute('href'), location.href); } catch (err) { return; }
    if (a.hasAttribute('download') || /^(#|javascript:)/i.test(a.getAttribute('href'))) return;
    // Messages and Notifications have popups of their own, wherever the link is.
    if (settings.pagePopups && url.origin === location.origin && !(settings.popupsOnlyOnTravel && !isTravelPage)) {
      if (settings.chatPopup && /^\/messages\/(inbox|view\/chat)/.test(url.pathname)) { e.preventDefault(); e.stopPropagation(); openChat('private'); return; }
      if (settings.notificationsPopup && url.pathname === '/events') { e.preventDefault(); e.stopPropagation(); openNotes(); return; }
    }
    const def = popupFor(url);
    if (!def || (a.target === '_blank' && !def.newTabLink)) return;
    e.preventDefault();
    e.stopPropagation();
    openPagePopup(url, def, a.textContent.replace(/\s+/g, ' ').trim().slice(0, 40));
  }, true);

  // ---------------------------------------------------------------------------
  // The human check always opens in the page popup
  // ---------------------------------------------------------------------------
  // The game's "make sure you're a human" message links to the checkpoint with target="_blank" (a new tab),
  // also when it shows up inside one of our popups. Catch that link, and window.open() calls for it,
  // in the main page and in every popup page, and open the checkpoint in the page popup instead.
  // (If a popup is already open, the checkpoint replaces what it shows.)
  const CHECKPOINT = /\/i-am-not-a-bot/;

  function openCheckpoint(href) {
    let url;
    try { url = new URL(href, location.origin); } catch (err) { return; }
    const def = PAGE_NAMES.find((p) => p.path === '/i-am-not-a-bot') || { name: 'Human check' };
    openPagePopup(url, def, 'Human check');
  }

  function catchCheckpoint(win) {
    if (!win || win.__stcCheckpoint) return;
    win.__stcCheckpoint = true;
    win.document.addEventListener('click', function (e) {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return; // Ctrl+click still opens a tab
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a || !CHECKPOINT.test(a.getAttribute('href'))) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      openCheckpoint(a.getAttribute('href'));
    }, true);
    const open = win.open;
    win.open = function (url) {
      if (url && CHECKPOINT.test(String(url))) { openCheckpoint(String(url)); return null; }
      return open.apply(this, arguments);
    };
  }

  catchCheckpoint(window);

  // ---------------------------------------------------------------------------
  // "Add to Collection" in the game's item window
  // ---------------------------------------------------------------------------
  // The item window (opened by clicking an item) has Quick Sell and Lock Item, but no way to add
  // the item to your collection. The Inventory page does, so this button takes you there, filtered to the item.
  function findItemWindow() {
    for (const el of document.querySelectorAll('[x-data]')) {
      const data = el._x_dataStack && el._x_dataStack[0];
      if (data && 'quickSellV2' in data) return { el: el, data: data };
    }
    return null;
  }

  function enhanceItemWindow() {
    const win = findItemWindow();
    if (!win) return;
    if (isVisible(win.el)) learnFromItemWindow(win.data.item);
    const lockBtn = [...win.el.querySelectorAll('button')].find((b) => /lock item|unlock item/i.test(b.textContent) && isVisible(b));
    const existing = win.el.querySelector('.stc-collect-btn');
    const item = win.data.item;
    const inInventory = item && item.quantity_data ? item.quantity_data.inventory : 0;
    const wanted = lockBtn && item && item.collection && item.collection.item === 0 && inInventory > 0;
    if (!wanted) { if (existing) existing.remove(); return; }
    if (existing && existing.dataset.itemId === String(item.id)) return;
    if (existing) existing.remove();

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = lockBtn.className + ' stc-collect-btn'; // looks like the game's own buttons
    btn.textContent = 'Add to Collection';
    btn.dataset.itemId = String(item.id);
    btn.title = 'Opens your Inventory with just this item, where you can add it to your collection';
    btn.addEventListener('click', function () { askAddToCollection(item); });
    lockBtn.after(btn);
  }

  // Opens your Inventory in the popup, filtered to this item, so you can use the game's own
  // "Add to Collection" button there. (The game refuses its add-to-collection address when it's
  // opened any other way, so the companion doesn't try to do that part itself.)
  function askAddToCollection(item) {
    const url = new URL('/inventory/items?itemname=' + encodeURIComponent(item.name), location.origin);
    openPagePopup(url, { name: 'Add to Collection: ' + item.name });
    showToast('Click the game\u2019s \u201CAdd to Collection\u201D next to ' + item.name + ' in the list.');
  }


  // Your private chats. The game allows its own pages to be shown this way.
  function ensurePrivateFrame(url) {
    if (privateFrame) return;
    privateFrame = document.createElement('iframe');
    privateFrame.title = 'Private messages';
    privateFrame.src = url;
    privateFrame.addEventListener('load', function () {
      try {
        const doc = privateFrame.contentDocument;
        hideGameChrome(doc); // only the messages show
        wireFrame(doc);
        const where = privateFrame.contentWindow.location;
        privatePath = where.pathname;
        if (/^\/(messages|chat)\b/.test(where.pathname)) setChatState({ privateUrl: where.pathname + where.search });
      } catch (err) { /* page not readable: leave it as is */ }
      syncChat();
    });
    $('stc-dock-body').appendChild(privateFrame);
  }

  // Show the right tab's page and buttons.
  function syncChat() {
    const tab = chatState().tab;
    dock.querySelectorAll('[data-dock-tab]').forEach((b) => b.classList.toggle('active', b.dataset.dockTab === tab));
    if (globalFrame) globalFrame.style.display = tab === 'global' ? 'block' : 'none';
    if (privateFrame) privateFrame.style.display = tab === 'private' ? 'block' : 'none';
    // "< Chats" shows while a single private conversation is open.
    $('stc-dock-back').style.display = tab === 'private' && /^\/chat\//.test(privatePath) ? '' : 'none';
    const hint = $('stc-dock-hint');
    const noGlobal = tab === 'global' && !globalFrame;
    hint.style.display = noGlobal ? 'block' : 'none';
    hint.textContent = 'The global chat isn\u2019t available on this page. Try again from another page, or use the game\u2019s Show Chat button.';
  }

  // ---------------------------------------------------------------------------
  // New private messages: watch the Messages icon in the game's top bar for a badge
  // ---------------------------------------------------------------------------
  function readUnread() {
    const link = findMessagesIcon();
    if (!link) return 0;
    const scope = link.closest('aside') ? (link.closest('.relative') || link) : link;
    // Anything inside the icon besides the icon itself and its screen-reader label counts as a badge.
    const extra = [...scope.querySelectorAll('*')].filter((el) =>
      !el.closest('svg') && el.tagName !== 'svg' && !el.classList.contains('sr-only') && el.tagName !== 'BUTTON' && el.tagName !== 'A' && isVisible(el));
    if (!extra.length) return 0;
    const number = extra.map((el) => parseInt(el.textContent.trim(), 10)).find((n) => n > 0);
    return number || 1;
  }

  // Only the leader tab saves the count and alerts, so you hear it once.
  function checkMessages() {
    if (!isLeader()) return;
    const unread = readUnread();
    const previous = load(KEY.data, {}).unread || 0;
    if (unread !== previous) update(KEY.data, (d) => { d.unread = unread; d.unreadAt = Date.now(); });
    if (settings.messageAlert && unread > previous) cue('New private message', 784);
  }

  function renderUnread() {
    const unread = load(KEY.data, {}).unread || 0;
    const badge = $('stc-dock-unread');
    badge.textContent = unread;
    badge.style.display = unread ? 'inline' : 'none';
    if (sideEl) {
      const row = sideEl.querySelector('[data-s="msg"]');
      if (row) {
        row.parentElement.style.display = rowShown('messages') && (unread || settings.chatPopup) ? '' : 'none';
        setHtml(row, unread ? '<span class="stc-unread">' + unread + ' new</span>' : muted('—'));
      }
    }
  }

  // ===========================================================================
  // 15. Walking tracker (Travel page only)
  // ===========================================================================
  let travelEl = null;
  let wasDisabled = null;
  let awaitingResult = false;
  let travelBlocked = false; // the game refused the last step

  function getTravelData() {
    if (!travelEl || !travelEl.isConnected) {
      travelEl = document.querySelector('[id^="step_btn_"]');
      while (travelEl && !travelEl._x_dataStack) travelEl = travelEl.parentElement;
    }
    const data = travelEl && travelEl._x_dataStack && travelEl._x_dataStack[0];
    return data && data.travel ? data : null;
  }

  // You can't travel while your job is running.
  function jobBlocksTravel() {
    const job = load(KEY.timers, {}).job;
    return !!(job && job.working && job.endsAt > Date.now());
  }

  // The game's answer when a step was refused.
  function travelRefused() {
    const container = document.getElementById('complete-travel-container') || document.querySelector('main');
    return /cannot travel/i.test(container ? container.innerText : '');
  }

  // The human check ("A quick stop on your journey"): an "Open the checkpoint" link to /i-am-not-a-bot.
  // While it's showing, your next step waits until you've done the check yourself.
  function humanCheckShowing() {
    return [...document.querySelectorAll('a[href*="/i-am-not-a-bot"]')].some(isVisible);
  }

  function setWalkStatus(state) {
    if (!walkCard) return;
    let text = 'Open the Travel page to track steps';
    if (state === 'ready') text = 'Ready to step';
    if (state === 'wait') text = 'Cooling down\u2026';
    if (state === 'blocked') {
      const job = load(KEY.timers, {}).job;
      text = 'Working: no travel' + (job && job.endsAt ? ' for ' + formatDuration(job.endsAt - Date.now()) : '');
    }
    if (state === 'check') text = 'Human check waiting: open the checkpoint';
    walkCard.querySelector('[data-w="dot"]').className = 'stc-dot ' + (state === 'check' ? 'blocked' : state);
    setHtml(walkCard.querySelector('[data-w="status"]'), escapeHtml(text));
  }


  // Without an API key, estimate level progress from the Travel page's EXP bar.
  function levelFromTravelPage(data) {
    if (settings.apiKey || !data.user) return;
    const level = toNumber(data.user.level);
    const pct = data.user.exp_percentage;
    if (!level || typeof pct !== 'number') return;
    const old = load(KEY.timers, {}).level;
    if (old && old.level === level && (!old.approx || old.pct === pct)) return;
    const needed = 50 * level;
    setTimer('level', { level: level, into: Math.round(needed * pct / 100), needed: needed, gainedSince: 0, approx: true, pct: pct });
  }

  // What the step turned up besides an item: a material to gather, or an enemy.
  // Gathering (salvage, chop, mine, catch) is an action you take, not an item you find.
  function stepEncounter() {
    const container = document.getElementById('complete-travel-container') || document.querySelector('main');
    const controls = [...container.querySelectorAll('a, button')].filter((el) => isVisible(el) && !el.closest('.stc-strip, .stc-side') && !/^step_btn_/.test(el.id));
    const gather = controls.some((el) =>
      /^(salvage|chop|mine|catch|fish|gather|harvest)\b/i.test(el.textContent.trim()) ||
      /gather/i.test(el.getAttribute('x-on:click') || ''));
    if (gather) return 'gather';
    if (controls.some((el) => el.tagName === 'A' && /\/npcs\//.test(el.getAttribute('href') || ''))) return 'npc';
    return null;
  }

  // Count each fight once, when its battle page opens (in the popup or as a full page).
  function noteBattle(pathname) {
    const m = pathname.match(/^\/npcs\/attack\/(\d+)/);
    if (!m) return;
    const id = m[1];
    const add = (s) => {
      s.foughtIds = s.foughtIds || [];
      if (s.foughtIds.includes(id)) return false;
      s.foughtIds.push(id);
      if (s.foughtIds.length > 300) s.foughtIds.shift();
      s.fought = (s.fought || 0) + 1;
      s.lastActivityAt = Date.now();
      return true;
    };
    // Fights count toward a running session; only a step starts one.
    if (!session.active) return;
    if (add(session)) save(KEY.session, session);
  }

  // Items found on a step show up in the travel text with a rarity colour class.
  // The game also shows a rarity label ("Rare") with the same class next to the item,
  // so labels are only used when no item name of that rarity was found.
  function readStepLoot() {
    const named = [];
    const labels = [];
    const container = document.getElementById('complete-travel-container') || document.querySelector('main');
    container.querySelectorAll('[class*="-item"]').forEach(function (el) {
      if (el.closest('.stc-strip, .stc-side') || !isVisible(el)) return;
      const rarity = rarityOf(el);
      const name = el.textContent.trim().replace(/\s+/g, ' ');
      if (!rarity || !name) return;
      if (RARITIES.includes(name.toLowerCase())) labels.push(rarity);
      else named.push({ name: name.slice(0, 60), rarity: rarity });
    });
    labels.forEach(function (rarity) {
      if (!named.some((n) => n.rarity === rarity)) named.push({ name: rarity[0].toUpperCase() + rarity.slice(1) + ' item', rarity: rarity });
    });
    return named;
  }

  function walkTick() {
    const data = getTravelData();
    if (!data) { setWalkStatus(''); return; }

    levelFromTravelPage(data);
    const disabled = !!(data.travel.button_disabled || data.is_action_loading);

    // Ready -> cooling down: you just clicked the step button.
    if (wasDisabled === false && disabled) {
      awaitingResult = true;
      setTitleReady(false);
    }

    // Cooling down -> ready: the step's result is on screen. Count it, unless the game refused it
    // or stopped you at the human check (then the step hasn't happened yet).
    let refused = false;
    const check = humanCheckShowing();
    if (wasDisabled === true && !disabled) {
      refused = travelRefused();
      travelBlocked = refused;
      const noResult = data.travel.heading === undefined && data.travel.exp === undefined;
      if (awaitingResult && !refused && !check && !noResult) {
        if (!session.active) session = newSession(Date.now());
        session.steps += 1;
        session.lastStepAt = Date.now();
        session.lastActivityAt = Date.now();
        const gold = toNumber(data.travel.gold);
        const exp = toNumber(data.travel.exp);
        session.gold += gold;
        session.exp += exp;
        session.loot = session.loot || {};
        session.lootLog = session.lootLog || [];
        const encounter = stepEncounter();
        if (encounter === 'npc') session.enemiesMet = (session.enemiesMet || 0) + 1;
        if (encounter !== 'gather') {
          readStepLoot().forEach(function (item) {
            session.loot[item.rarity] = (session.loot[item.rarity] || 0) + 1;
            session.lootLog.unshift({ t: Date.now(), name: item.name, rarity: item.rarity });
          });
        }
        if (session.lootLog.length > 50) session.lootLog.length = 50;
        update(KEY.lifetime, (l) => { l.steps = (l.steps || 0) + 1; l.exp = (l.exp || 0) + exp; });
        if (data.user) recordStepSample(toNumber(data.user.level), data.user.exp_percentage, exp);
        // With the API, add the step's EXP until the next update. Without it, the game's
        // own EXP bar (read on every step) is already up to date.
        update(KEY.timers, (t) => { if (t.level && !t.level.approx) t.level.gainedSince = (t.level.gainedSince || 0) + exp; });
        // Remember your total EXP at the start of the session, so everything after it counts.
        if (session.startTotal === undefined || session.startTotal === null) {
          const total = currentTotalExp();
          if (total !== null) session.startTotal = total - session.exp;
        }
        save(KEY.session, session);
      }
      awaitingResult = false;
      // No sound here: you're on the page taking steps yourself. Only the tab title changes.
      if (!refused && !check && !jobBlocksTravel()) setTitleReady(true);
    }

    wasDisabled = disabled;
    if (check) {
      setWalkStatus('check');
      setTitleReady(false);
    } else if (jobBlocksTravel() || (travelBlocked && !disabled)) {
      setWalkStatus('blocked');
      setTitleReady(false);
    } else {
      setWalkStatus(disabled ? 'wait' : 'ready');
    }
  }

  // ===========================================================================
  // 16. Start
  // ===========================================================================
  checkSessionIdle();
  noteBattle(PATH);
  buildPageExtras();
  readCurrentPage();
  readLayoutSetting();
  watchGivingPage(document, location);

  let guardTick = 0;
  setInterval(function () {
    settings = load(KEY.settings, DEFAULT_SETTINGS); // pick up changes made in other tabs
    enhanceItemWindow();
    session = loadSession(); // shared between tabs
    checkSessionIdle();
    if (isTravelPage) walkTick();
    else setWalkStatus('');
    render();
    if (++guardTick % 2 === 0) guardAllGivingPages();
  }, 250);

  setInterval(function () {
    readCurrentPage();
    buildPageExtras(); // the game sometimes redraws parts of the page
    markCollection();
  }, 3000);

  setInterval(function () {
    backgroundTick();
    apiTick();
    checkAlerts();
    checkVerification();
    checkMessages();
    autoScanCollection();
  }, 2000);
})();