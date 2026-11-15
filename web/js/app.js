/**
 * GLOBAL FIRE INTELLIGENCE (GFI) — Scientific Geospatial Frontend Engine
 * NASA Space Apps Challenge: Harmonization of MODIS (1km) and VIIRS (375m) Hot Spots
 */

const API_HOST = window.location.hostname || "127.0.0.1";
const _explicitApiBase = (
  new URLSearchParams(window.location.search).get("api") ||
  window.CHOKI_API_BASE ||
  ""
).trim().replace(/\/+$/, "");
const API_BASE = _explicitApiBase
  ? _explicitApiBase
  : (window.location.port && window.location.port !== "80" && window.location.port !== "443")
    ? ""
    : (window.location.protocol === "https:" || API_HOST.endsWith(".github.io"))
      ? null
      : `http://${API_HOST}:8766`;

let _backendCooldownUntil = 0;
let _staticFallbackPromise = null;

async function getStaticFallback() {
  if (!_staticFallbackPromise) {
    _staticFallbackPromise = fetch("./data/static_fallback.json")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return _staticFallbackPromise;
}

async function apiFetch(path, options = {}) {
  if (API_BASE === null) {
    throw new Error("STATIC_HOST_NO_BACKEND");
  }
  if (API_BASE && Date.now() < _backendCooldownUntil) {
    throw new Error("BACKEND_COOLDOWN");
  }
  const fetchOpts = { ...options };
  if (fetchOpts.headers && fetchOpts.headers["Content-Type"] === "application/json") {
    // Use CORS Simple Request (text/plain;charset=UTF-8) to avoid OPTIONS preflight overhead & blocks
    const h = { ...fetchOpts.headers };
    delete h["Content-Type"];
    fetchOpts.headers = h;
  }
  try {
    const res = await fetch(`${API_BASE}${path}`, fetchOpts);
    _backendCooldownUntil = 0;
    return res;
  } catch (err) {
    if (API_BASE) {
      _backendCooldownUntil = Date.now() + 25000;
    }
    throw err;
  }
}

const _initialToday = new Date();
const GFIState = {
  regions: [],
  regionCode: "ALL",
  metricMode: "harmonized_calibrated",
  targetYear: Math.min(2026, Math.max(2001, _initialToday.getFullYear())),
  targetMonth: _initialToday.getMonth() + 1,
  targetDay: String(_initialToday.getDate()),
  calendarDisplayMode: "value",
  overviewData: null,
  hotspotsData: null,
  selectedHotspot: null,
  analysisYearA: 2026,
  analysisYearB: 2011,
  compRegionA: "MX-CHH",
  compRegionB: "BR-AMZ",

  // MapLibre 3D Globe & GIS State
  map: {
    overviewInstance: null,
    mainInstance: null,
    projectionMode: "globe", // 'globe' | 'mercator'
    basemapMode: "satellite", // 'satellite' | 'dark'
    centerLat: 15.0,
    centerLon: -30.0,
    zoom: 1.9,
    tool: "pan", // 'pan' | 'rect' | 'poly' | 'measure' | 'pick_loc'
    isDrawingRect: false,
    rectStartLngLat: null,
    rectCurrentLngLat: null,
    customBBox: null, // {minLat, maxLat, minLon, maxLon}
    polygonPoints: [], // [[lat, lon], ...]
    measurePoints: [], // [[lat, lon], ...]
    layers: { clouds: false, topo: false },
  },
};

const USER_COORDS_STORAGE_KEY = "choki_user_coords_v1";

const OfflineCache = {
  dbPromise: null,
  open() {
    if (this.dbPromise) return this.dbPromise;
    if (typeof indexedDB === "undefined") return Promise.resolve(null);
    this.dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open("choki_offline_db", 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("telemetry")) {
            db.createObjectStore("telemetry", { keyPath: "key" });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
    return this.dbPromise;
  },
  async get(key) {
    const db = await this.open();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction("telemetry", "readonly");
        const req = tx.objectStore("telemetry").get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
  },
  async set(key, data) {
    const db = await this.open();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction("telemetry", "readwrite");
        tx.objectStore("telemetry").put({ key, data, updatedAt: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (_) {
        resolve();
      }
    });
  },
};

function registerOfflineServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

function updateConnectivityHud(isOffline) {
  const dot = document.getElementById("hud-sync-dot");
  const lbl = document.getElementById("hud-sync-label");
  if (!dot || !lbl) return;
  if (isOffline) {
    dot.classList.remove("syncing");
    dot.style.background = "#f59e0b";
    lbl.textContent = "Offline Mode";
  } else {
    dot.classList.remove("syncing");
    dot.style.background = "#10b981";
    lbl.textContent = "Online";
  }
}

function loadSavedUserCoords() {
  try {
    const raw = localStorage.getItem(USER_COORDS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.lat === "number" && typeof parsed?.lon === "number") {
      return parsed;
    }
  } catch (_) {}
  return null;
}

function saveUserCoords(coords) {
  try {
    if (coords) {
      localStorage.setItem(USER_COORDS_STORAGE_KEY, JSON.stringify(coords));
    }
  } catch (_) {}
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

/* ==========================================================================
   1. INITIALIZATION & NAVIGATION
   ========================================================================== */

document.addEventListener("DOMContentLoaded", async () => {
  initYearSelectors();
  bindNavigationEvents();
  bindGlobalControls();
  syncBottomMonthPills();
  bindWatchdogControls();
  registerOfflineServiceWorker();

  window.addEventListener("online", () => {
    updateConnectivityHud(false);
    refreshAllActiveData().catch(() => {});
  });
  window.addEventListener("offline", () => updateConnectivityHud(true));
  if (!navigator.onLine) updateConnectivityHud(true);

  const savedCoords = loadSavedUserCoords();
  if (savedCoords) {
    monitoredUserCoords = savedCoords;
    GFIState.map.centerLat = savedCoords.lat;
    GFIState.map.centerLon = savedCoords.lon;
    syncTopSearchWithLocation();
  }

  // Run the 60fps splash animation in total isolation first so zero multi-MB JSON parsing
  // or IndexedDB structuredClone work ever blocks the main thread during the intro.
  await initChokiSplash();

  initMapLibreMaps();
  bindMapControls();
  startLiveHudClock();
  updateUserLocationMarker();

  await Promise.allSettled([
    loadRegionsList({ skipFly: Boolean(savedCoords) }),
    refreshAllActiveData(),
  ]);

  if (!GFIState.hotspotsData) {
    await hydrateInitialStateFromCache();
    if (GFIState.overviewData) renderAllOverviewWidgets();
    if (GFIState.hotspotsData) {
      updateMapLibreData();
      renderMapSummaryBox();
    }
  }

  initSwathWatchdog(Boolean(savedCoords));
});

function escapeHtml(val) {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getLocalGmtLabel() {
  const now = new Date();
  const offMin = -now.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  let tzName = "";
  try {
    tzName = Intl.DateTimeFormat(undefined, { timeZoneName: "long" }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value || "";
  } catch (_) {}
  return tzName ? `Local Time GMT${sign}${hh}${mm} (${tzName})` : `Local Time GMT${sign}${hh}${mm}`;
}

function formatAcquisitionTimestamp(acqDate, acqTime, tzMode = "local") {
  const dateStr = String(acqDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return `${dateStr} ${acqTime || ""}`.trim();
  const digits = String(acqTime || "0000").replace(/[^0-9]/g, "").padStart(4, "0");
  const hh = Math.min(23, parseInt(digits.slice(0, 2), 10) || 0);
  const mm = Math.min(59, parseInt(digits.slice(2, 4), 10) || 0);
  const ss = digits.length >= 6 ? Math.min(59, parseInt(digits.slice(4, 6), 10) || 0) : 0;

  const [y, m, d] = dateStr.split("-").map((n) => parseInt(n, 10));
  const dt = new Date(Date.UTC(y, m - 1, d, hh, mm, ss));
  const p = (n) => String(n).padStart(2, "0");
  if (tzMode === "utc") {
    return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())} ${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}:${p(dt.getUTCSeconds())}`;
  }
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
}

function startLiveHudClock() {
  const tzEl = document.getElementById("firms-local-tz-label");
  if (tzEl) tzEl.textContent = getLocalGmtLabel();

  if (window.ChokiReactUI?.mountClock) {
    window.ChokiReactUI.mountClock();
    return;
  }

  const tick = () => {
    const el = document.getElementById("hud-clock-label");
    if (!el) return;
    const now = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const localStr = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
    const utcStr = `${p(now.getUTCHours())}:${p(now.getUTCMinutes())} UTC`;
    el.textContent = `${localStr} • ${utcStr}`;
  };
  tick();
  setInterval(tick, 1000);
}

function initYearSelectors() {
  const yearSelects = [
    document.getElementById("global-year-select"),
    document.getElementById("analysis-year-a"),
    document.getElementById("analysis-year-b"),
  ];
  yearSelects.forEach((sel, idx) => {
    if (!sel) return;
    sel.innerHTML = "";
    for (let y = Math.max(2026, _initialToday.getFullYear()); y >= 2001; y--) {
      const opt = document.createElement("option");
      opt.value = String(y);
      opt.textContent = String(y);
      if (idx === 0 && y === GFIState.targetYear) opt.selected = true;
      if (idx === 1 && y === GFIState.analysisYearA) opt.selected = true;
      if (idx === 2 && y === GFIState.analysisYearB) opt.selected = true;
      sel.appendChild(opt);
    }
  });
  const monthEl = document.getElementById("global-month-select");
  if (monthEl) monthEl.value = String(GFIState.targetMonth);
  const dayEl = document.getElementById("global-day-select");
  if (dayEl) dayEl.value = String(GFIState.targetDay);
  const stepEl = document.getElementById("timeline-step-mode");
  if (stepEl) stepEl.value = "day";
}

function ensureDateDrivenMapScope() {
  const scopeEl = document.getElementById("map-time-scope");
  if (
    scopeEl &&
    (scopeEl.value === "ALL_YEARS" ||
      scopeEl.value === "SELECTED_YEAR" ||
      scopeEl.value === "LIVE_24H" ||
      scopeEl.value === "LIVE_7D" ||
      scopeEl.value === "LIVE_FIRMS_ONLY")
  ) {
    scopeEl.value = "SELECTED_MONTH";
    document.querySelectorAll("#firms-window-bar .seg-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.scope === "SELECTED_MONTH");
    });
  }
  GFIState.selectedHotspot = null;
  const popupDateEl = document.getElementById("firms-popup-filter-date");
  if (popupDateEl) popupDateEl.value = "ALL";
}

function bindNavigationEvents() {
  const tabs = document.querySelectorAll(".nav-tab");
  tabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetView = btn.getAttribute("data-view");
      switchView(targetView);
    });
  });

  document.getElementById("btn-close-overlay")?.addEventListener("click", () => switchView("map"));

  const setLeftHudHidden = (hidden) => {
    document.getElementById("hud-left-panel")?.classList.toggle("hud-left-collapsed", hidden);
    document.body.classList.toggle("left-hud-hidden", hidden);
  };
  const setRightHudHidden = (hidden) => {
    document.getElementById("hud-right-panel")?.classList.toggle("hud-collapsed", hidden);
    document.body.classList.toggle("right-hud-hidden", hidden);
  };

  document.getElementById("btn-toggle-left-hud")?.addEventListener("click", () => setLeftHudHidden(true));
  document.getElementById("tab-open-left-hud")?.addEventListener("click", () => {
    setLeftHudHidden(!document.body.classList.contains("left-hud-hidden"));
  });
  document.getElementById("btn-toggle-right-hud")?.addEventListener("click", () => setRightHudHidden(true));
  document.getElementById("tab-open-right-hud")?.addEventListener("click", () => {
    setRightHudHidden(!document.body.classList.contains("right-hud-hidden"));
  });
  document.getElementById("btn-restore-huds")?.addEventListener("click", () => {
    const anyHidden =
      document.body.classList.contains("left-hud-hidden") ||
      document.body.classList.contains("right-hud-hidden");
    setLeftHudHidden(!anyHidden);
    setRightHudHidden(!anyHidden);
  });

  // Bottom weather-style month pills
  document.querySelectorAll("#bottom-months-strip .month-pill-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const m = parseInt(btn.getAttribute("data-m"), 10);
      GFIState.targetMonth = m;
      const sel = document.getElementById("global-month-select");
      if (sel) sel.value = String(m);
      ensureDateDrivenMapScope();
      syncBottomMonthPills();
      scheduleTimelineRefresh(40);
    });
  });

  // Toggle / Collapse Timeline Bar from Dock (TIMELINE orange tile + ✕ button)
  const timelineBar = document.getElementById("firms-timeline-bar");
  const toggleTimelineTile = document.getElementById("btn-toggle-timeline-bar");
  const collapseTimelineBtn = document.getElementById("btn-collapse-timeline");
  const toggleTimelineVisibility = () => {
    if (!timelineBar) return;
    const isCollapsed = timelineBar.classList.toggle("collapsed");
    toggleTimelineTile?.classList.toggle("active-timeline-tile", !isCollapsed);
    if (collapseTimelineBtn) {
      collapseTimelineBtn.textContent = isCollapsed ? "▲" : "✕";
    }
  };
  toggleTimelineTile?.addEventListener("click", toggleTimelineVisibility);
  collapseTimelineBtn?.addEventListener("click", toggleTimelineVisibility);

  // Year Stepper Arrows + Slider
  const yearSlider = document.getElementById("timeline-year-slider");
  const yearBadge = document.getElementById("timeline-year-badge");
  yearSlider?.addEventListener("input", (e) => {
    if (yearBadge) yearBadge.textContent = String(e.target.value);
  });
  yearSlider?.addEventListener("change", (e) => {
    GFIState.targetYear = parseInt(e.target.value, 10) || 2026;
    ensureDateDrivenMapScope();
    syncBottomMonthPills();
    scheduleTimelineRefresh(40);
  });

  document.getElementById("btn-timeline-year-prev")?.addEventListener("click", () => {
    GFIState.targetYear = Math.max(2001, (GFIState.targetYear || 2026) - 1);
    ensureDateDrivenMapScope();
    syncBottomMonthPills();
    scheduleTimelineRefresh(55);
  });
  document.getElementById("btn-timeline-year-next")?.addEventListener("click", () => {
    GFIState.targetYear = Math.min(2026, (GFIState.targetYear || 2026) + 1);
    ensureDateDrivenMapScope();
    syncBottomMonthPills();
    scheduleTimelineRefresh(55);
  });

  // Previous / Current Month Span Pills & Full Month Button
  document.getElementById("timeline-prev-month-pill")?.addEventListener("click", () => {
    let m = (GFIState.targetMonth || 11) - 1;
    let y = GFIState.targetYear || 2026;
    if (m < 1) {
      m = 12;
      y = Math.max(2001, y - 1);
    }
    GFIState.targetYear = y;
    GFIState.targetMonth = m;
    ensureDateDrivenMapScope();
    syncBottomMonthPills();
    scheduleTimelineRefresh(45);
  });

  const selectFullMonthScope = async () => {
    GFIState.targetDay = "ALL";
    const stepSel = document.getElementById("timeline-step-mode");
    if (stepSel) stepSel.value = "month";
    ensureDateDrivenMapScope();
    syncBottomMonthPills();
    await refreshAllActiveData();
  };
  document.getElementById("timeline-curr-month-pill")?.addEventListener("click", selectFullMonthScope);
  document.getElementById("btn-timeline-all-days")?.addEventListener("click", selectFullMonthScope);

  // Step Mode Selector & Custom Time Mode Modal (DAY / WEEK / MONTH / YEAR / ALL YEARS / 24H / 7D)
  const STEP_MODE_LABELS = {
    day: "DAY",
    week: "WEEK",
    month: "MONTH",
    year: "YEAR",
    all_years: "ALL YEARS",
    "24h": "24H",
    "7d": "7D",
  };

  const syncStepModeLabel = () => {
    const stepSel = document.getElementById("timeline-step-mode");
    const lbl = document.getElementById("timeline-step-mode-label");
    if (stepSel && lbl) {
      lbl.textContent = STEP_MODE_LABELS[stepSel.value] || "DAY";
    }
  };

  const applyTimelineScopeMode = async (mode) => {
    const stepSel = document.getElementById("timeline-step-mode");
    const scopeSel = document.getElementById("map-time-scope");
    if (stepSel) stepSel.value = mode;
    syncStepModeLabel();

    if (mode === "24h") {
      if (scopeSel) scopeSel.value = "LIVE_24H";
    } else if (mode === "7d") {
      if (scopeSel) scopeSel.value = "LIVE_7D";
    } else if (mode === "year") {
      if (scopeSel) scopeSel.value = "SELECTED_YEAR";
    } else if (mode === "all_years") {
      if (scopeSel) {
        if (!Array.from(scopeSel.options).some((o) => o.value === "ALL_YEARS")) {
          const opt = document.createElement("option");
          opt.value = "ALL_YEARS";
          opt.textContent = "All Years (2001–2026)";
          scopeSel.appendChild(opt);
        }
        scopeSel.value = "ALL_YEARS";
      }
    } else if (mode === "month") {
      GFIState.targetDay = "ALL";
      ensureDateDrivenMapScope();
    } else {
      if (GFIState.targetDay === "ALL") {
        const now = new Date();
        GFIState.targetDay = String(now.getDate());
      }
      ensureDateDrivenMapScope();
    }
    syncBottomMonthPills();
    await refreshAllActiveData();
  };

  document.getElementById("timeline-step-mode")?.addEventListener("change", (e) => {
    applyTimelineScopeMode(e.target.value);
  });

  const scopeModal = document.getElementById("timeline-scope-modal");
  const openScopeModal = () => {
    if (!scopeModal) return;
    const curMode = document.getElementById("timeline-step-mode")?.value || "day";
    scopeModal.querySelectorAll(".scope-modal-opt[data-scope-mode]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.getAttribute("data-scope-mode") === curMode);
    });
    scopeModal.style.display = "flex";
  };
  const closeScopeModal = () => {
    if (scopeModal) scopeModal.style.display = "none";
  };

  document.getElementById("btn-timeline-step-mode")?.addEventListener("click", openScopeModal);
  document.getElementById("btn-close-scope-modal")?.addEventListener("click", closeScopeModal);
  scopeModal?.addEventListener("click", (e) => {
    if (e.target === scopeModal) closeScopeModal();
  });
  scopeModal?.querySelectorAll(".scope-modal-opt[data-scope-mode]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const mode = btn.getAttribute("data-scope-mode");
      closeScopeModal();
      if (mode) await applyTimelineScopeMode(mode);
    });
  });

  // Step Backward (⏮) and Step Forward (⏭) — clamped to today (no future time-travel)
  const isFutureDate = (y, m, d) => {
    const now = new Date();
    const ty = now.getFullYear();
    const tm = now.getMonth() + 1;
    const td = now.getDate();
    if (y > ty) return true;
    if (y === ty && m > tm) return true;
    if (y === ty && m === tm && d > td) return true;
    return false;
  };

  const clampDateToToday = (y, m, d) => {
    const now = new Date();
    const ty = now.getFullYear();
    const tm = now.getMonth() + 1;
    const td = now.getDate();
    if (isFutureDate(y, m, d)) return { y: ty, m: tm, d: td };
    return { y, m, d };
  };

  const stepTimelineBy = async (dir) => {
    const mode = document.getElementById("timeline-step-mode")?.value || "week";
    const now = new Date();
    let y = GFIState.targetYear || now.getFullYear();
    let m = GFIState.targetMonth || (now.getMonth() + 1);
    let d = !GFIState.targetDay || GFIState.targetDay === "ALL" ? now.getDate() : parseInt(GFIState.targetDay, 10) || now.getDate();

    if (mode === "year") {
      y = Math.max(2001, Math.min(now.getFullYear(), y + dir));
      const clamped = clampDateToToday(y, m, d);
      y = clamped.y;
      m = clamped.m;
    } else if (mode === "month") {
      m += dir;
      if (m < 1) {
        m = 12;
        y = Math.max(2001, y - 1);
      } else if (m > 12) {
        m = 1;
        y = Math.min(now.getFullYear(), y + 1);
      }
      const clamped = clampDateToToday(y, m, 1);
      y = clamped.y;
      m = clamped.m;
    } else {
      const deltaDays = mode === "week" ? dir * 7 : dir;
      const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
      const clamped = clampDateToToday(
        Math.max(2001, dt.getUTCFullYear()),
        dt.getUTCMonth() + 1,
        dt.getUTCDate()
      );
      y = clamped.y;
      m = clamped.m;
      d = clamped.d;
      GFIState.targetDay = String(d);
    }

    GFIState.targetYear = y;
    GFIState.targetMonth = m;
    ensureDateDrivenMapScope();
    syncBottomMonthPills();
    scheduleTimelineRefresh(55);
  };

  document.getElementById("btn-timeline-prev")?.addEventListener("click", () => stepTimelineBy(-1));
  document.getElementById("btn-timeline-next")?.addEventListener("click", () => stepTimelineBy(1));

  document.getElementById("btn-timeline-today")?.addEventListener("click", async () => {
    const now = new Date();
    GFIState.targetYear = now.getFullYear();
    GFIState.targetMonth = now.getMonth() + 1;
    GFIState.targetDay = String(now.getDate());
    const stepSel = document.getElementById("timeline-step-mode");
    if (stepSel && stepSel.value === "month") stepSel.value = "day";
    ensureDateDrivenMapScope();
    syncBottomMonthPills();
    await refreshAllActiveData();
  });

  let timelinePlayTimer = null;
  const playBtn = document.getElementById("btn-timeline-play");
  playBtn?.addEventListener("click", () => {
    if (timelinePlayTimer) {
      clearInterval(timelinePlayTimer);
      timelinePlayTimer = null;
      playBtn.classList.remove("playing");
      playBtn.textContent = "▶";
      return;
    }
    playBtn.classList.add("playing");
    playBtn.textContent = "⏸";
    timelinePlayTimer = setInterval(async () => {
      await stepTimelineBy(1);
    }, 2000);
  });

  // Interactive Pointer Dragging & Wheel Scrubbing on the Day Ruler Track
  const daysTrack = document.getElementById("firms-timeline-days-track");
  let isDraggingRuler = false;
  let pendingRulerSelection = null;

  const resolveCellFromPointer = (clientX) => {
    if (!daysTrack) return null;
    const cells = Array.from(daysTrack.querySelectorAll(".firms-day-cell"));
    for (const c of cells) {
      const rect = c.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right) {
        return {
          year: parseInt(c.getAttribute("data-y"), 10),
          month: parseInt(c.getAttribute("data-m"), 10),
          day: parseInt(c.getAttribute("data-d"), 10),
        };
      }
    }
    return null;
  };

  daysTrack?.addEventListener("pointerdown", (e) => {
    const hit = resolveCellFromPointer(e.clientX);
    if (!hit || isFutureDate(hit.year, hit.month, hit.day)) return;
    isDraggingRuler = true;
    pendingRulerSelection = hit;
    try {
      daysTrack.setPointerCapture(e.pointerId);
    } catch (_) {}
    GFIState.targetYear = hit.year;
    GFIState.targetMonth = hit.month;
    GFIState.targetDay = String(hit.day);
    const stepSel = document.getElementById("timeline-step-mode");
    if (stepSel && stepSel.value === "month") stepSel.value = "day";
    renderFirmsTimelineRuler();
  });

  daysTrack?.addEventListener("pointermove", (e) => {
    if (!isDraggingRuler) return;
    const hit = resolveCellFromPointer(e.clientX);
    if (!hit || isFutureDate(hit.year, hit.month, hit.day)) return;
    if (
      !pendingRulerSelection ||
      pendingRulerSelection.day !== hit.day ||
      pendingRulerSelection.month !== hit.month
    ) {
      pendingRulerSelection = hit;
      GFIState.targetYear = hit.year;
      GFIState.targetMonth = hit.month;
      GFIState.targetDay = String(hit.day);
      renderFirmsTimelineRuler();
    }
  });

  const finishRulerDrag = async () => {
    if (!isDraggingRuler) return;
    isDraggingRuler = false;
    ensureDateDrivenMapScope();
    syncBottomMonthPills();
    await refreshAllActiveData();
  };

  daysTrack?.addEventListener("pointerup", finishRulerDrag);
  daysTrack?.addEventListener("pointercancel", finishRulerDrag);
}

const MONTH_FULL_UPPER = [
  "JANUARY",
  "FEBRUARY",
  "MARCH",
  "APRIL",
  "MAY",
  "JUNE",
  "JULY",
  "AUGUST",
  "SEPTEMBER",
  "OCTOBER",
  "NOVEMBER",
  "DECEMBER",
];

function renderFirmsTimelineRuler() {
  const track = document.getElementById("firms-timeline-days-track");
  if (!track) return;

  const year = GFIState.targetYear || 2026;
  const month = GFIState.targetMonth || 11;
  const isAllDays = !GFIState.targetDay || GFIState.targetDay === "ALL";
  const stepMode = document.getElementById("timeline-step-mode")?.value || "day";
  const stepModeLbl = document.getElementById("timeline-step-mode-label");
  if (stepModeLbl) {
    const modeMap = { day: "DAY", week: "WEEK", month: "MONTH", year: "YEAR", all_years: "ALL YEARS", "24h": "24H", "7d": "7D" };
    stepModeLbl.textContent = modeMap[stepMode] || "DAY";
  }

  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? Math.max(2001, year - 1) : year;
  const daysInPrevMonth = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate();
  const daysInCurrMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  // Update Top Month Span Pills (e.g., OCTOBER 2026 | NOVEMBER 2026)
  const prevPill = document.getElementById("timeline-prev-month-pill");
  const currPill = document.getElementById("timeline-curr-month-pill");
  if (prevPill) prevPill.textContent = `${MONTH_FULL_UPPER[prevMonth - 1]} ${prevYear}`;
  if (currPill) currPill.textContent = `${MONTH_FULL_UPPER[month - 1]} ${year}`;

  const allDaysBtn = document.getElementById("btn-timeline-all-days");
  if (allDaysBtn) allDaysBtn.classList.toggle("active", isAllDays);

  // Anchor day defaults to today's date
  const todayDay = new Date().getDate();
  const anchorDay = isAllDays ? Math.min(todayDay, daysInCurrMonth) : Math.min(daysInCurrMonth, parseInt(GFIState.targetDay, 10) || todayDay);

  // Update Right Control Pod Active Date Pill (e.g., NOV 15 2026)
  const datePill = document.getElementById("timeline-active-date-pill");
  if (datePill) {
    if (isAllDays && stepMode === "month") {
      datePill.textContent = `${MONTH_SHORT[month - 1].toUpperCase()} ${year} (ALL)`;
    } else {
      datePill.textContent = `${MONTH_SHORT[month - 1].toUpperCase()} ${String(anchorDay).padStart(2, "0")} ${year}`;
    }
  }

  // Build continuous day cells: last 10 days of previous month + all days of active month
  const tailCount = 10;
  const cells = [];
  for (let d = daysInPrevMonth - tailCount + 1; d <= daysInPrevMonth; d++) {
    cells.push({ y: prevYear, m: prevMonth, d, isPrev: true, isStartOfCurr: false });
  }
  for (let d = 1; d <= daysInCurrMonth; d++) {
    cells.push({ y: year, m: month, d, isPrev: false, isStartOfCurr: d === 1 });
  }

  // Determine highlighted window indices
  const anchorIdx = cells.findIndex((c) => !c.isPrev && c.d === anchorDay);
  let winStartIdx = anchorIdx;
  let winEndIdx = anchorIdx;

  if (isAllDays && stepMode === "month") {
    winStartIdx = tailCount;
    winEndIdx = cells.length - 1;
  } else if (stepMode === "week") {
    winStartIdx = Math.max(0, anchorIdx - 6);
    winEndIdx = anchorIdx;
  }

  const nowToday = new Date();
  const todayY = nowToday.getFullYear();
  const todayM = nowToday.getMonth() + 1;
  const todayD = nowToday.getDate();

  const frag = document.createDocumentFragment();
  cells.forEach((cell, idx) => {
    const el = document.createElement("button");
    el.type = "button";
    const isFutureCell =
      cell.y > todayY ||
      (cell.y === todayY && cell.m > todayM) ||
      (cell.y === todayY && cell.m === todayM && cell.d > todayD);
    let cls = "firms-day-cell";
    if (cell.isPrev) cls += " prev-month-day";
    if (cell.isStartOfCurr) cls += " month-start-divider";
    if (isFutureCell) {
      cls += " future-day";
      el.disabled = true;
    }
    if (!isFutureCell && idx >= winStartIdx && idx <= winEndIdx) {
      cls += " in-window";
      if (idx === winStartIdx) cls += " window-start";
      if (idx === winEndIdx) cls += " window-end";
    }
    if (!isFutureCell && idx === anchorIdx && !(isAllDays && stepMode === "month")) {
      cls += " selected-day";
    }
    el.className = cls;
    el.setAttribute("data-y", String(cell.y));
    el.setAttribute("data-m", String(cell.m));
    el.setAttribute("data-d", String(cell.d));
    el.title = isFutureCell
      ? `${MONTH_SHORT[cell.m - 1]} ${String(cell.d).padStart(2, "0")}, ${cell.y} (Future — no overpass yet)`
      : `${MONTH_SHORT[cell.m - 1]} ${String(cell.d).padStart(2, "0")}, ${cell.y}`;
    el.textContent = String(cell.d);
    frag.appendChild(el);
  });

  track.innerHTML = "";
  track.appendChild(frag);
}

function syncBottomMonthPills() {
  document.querySelectorAll("#bottom-months-strip .month-pill-btn").forEach((btn) => {
    btn.classList.toggle("active", parseInt(btn.getAttribute("data-m"), 10) === GFIState.targetMonth);
  });
  const monthSel = document.getElementById("global-month-select");
  if (monthSel && String(monthSel.value) !== String(GFIState.targetMonth)) {
    monthSel.value = String(GFIState.targetMonth);
  }
  const yearSel = document.getElementById("global-year-select");
  if (yearSel && String(yearSel.value) !== String(GFIState.targetYear)) {
    yearSel.value = String(GFIState.targetYear);
  }
  const yearSlider = document.getElementById("timeline-year-slider");
  if (yearSlider) yearSlider.value = String(GFIState.targetYear || 2026);
  const yearBadge = document.getElementById("timeline-year-badge");
  if (yearBadge) yearBadge.textContent = String(GFIState.targetYear || 2026);

  const dayVal = !GFIState.targetDay || GFIState.targetDay === "ALL" ? 0 : parseInt(GFIState.targetDay, 10) || 0;
  const daySel = document.getElementById("global-day-select");
  if (daySel) daySel.value = dayVal === 0 ? "ALL" : String(dayVal);
  const daySlider = document.getElementById("timeline-day-slider");
  if (daySlider) daySlider.value = String(dayVal);
  const dayBadge = document.getElementById("timeline-day-badge");
  if (dayBadge) {
    dayBadge.textContent =
      dayVal === 0 ? "All Days" : `${MONTH_SHORT[(GFIState.targetMonth || 11) - 1]} ${String(dayVal).padStart(2, "0")}`;
  }
  renderFirmsTimelineRuler();
}

const VIEW_TITLES = {
  "validation-proof": "✓ Empirical Harmonization Proof & Auditable Quality Control",
  calendar: "📅 Historical Fire Activity Calendar (2001–2026)",
  analysis: "Fire Analytics, Trends & Calibration",
  comparison: "⚖️ Cross-Regional Fire Regime Comparison",
  methodology: "🔬 MODIS / VIIRS Scientific Harmonization Methodology",
};

function switchView(viewName) {
  document.querySelectorAll(".nav-tab").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-view") === viewName);
  });

  const overlay = document.getElementById("analytical-overlay");
  if (viewName === "map") {
    overlay?.classList.remove("active");
    GFIState.map.mainInstance?.resize();
    updateMapLibreData(true);
    if (!GFIState.hotspotsData?.hotspots?.length) {
      loadSpatialHotspots().catch(() => {});
    }
    return;
  }

  overlay?.classList.add("active");
  const titleEl = document.getElementById("overlay-view-title");
  if (titleEl) titleEl.textContent = VIEW_TITLES[viewName] || "Chokí Scientific Panel";

  document.querySelectorAll(".view-section").forEach((sec) => {
    sec.classList.toggle("active", sec.id === `view-${viewName}`);
  });

  requestAnimationFrame(() => {
    if (viewName === "validation-proof") {
      loadAndRenderValidationProof(GFIState.selectedZoneRecords || null);
    } else if (viewName === "calendar" && GFIState.overviewData) {
      renderCalendarSameMonthChart();
    } else if (viewName === "analysis" && GFIState.overviewData) {
      renderHistoricalAnalysisView();
    } else if (viewName === "comparison") {
      loadAndRenderRegionalComparison();
    }
  });
}

let _timelineRefreshTimer = null;
function scheduleTimelineRefresh(delayMs = 55) {
  if (_timelineRefreshTimer) clearTimeout(_timelineRefreshTimer);
  _timelineRefreshTimer = setTimeout(() => {
    _timelineRefreshTimer = null;
    refreshAllActiveData();
  }, delayMs);
}

function bindGlobalControls() {
  document.getElementById("global-region-select")?.addEventListener("change", async (e) => {
    GFIState.regionCode = e.target.value;
    GFIState.map.customBBox = null;
    GFIState.map.polygonPoints = [];
    syncMapCenterToRegion(GFIState.regionCode);
    await refreshAllActiveData();
  });

  document.getElementById("global-metric-select")?.addEventListener("change", async (e) => {
    GFIState.metricMode = e.target.value;
    updateNatureBadge();
    applyMapVisualLayerMode();
    await refreshAllActiveData();
  });

  document.getElementById("global-day-select")?.addEventListener("change", (e) => {
    GFIState.targetDay = e.target.value || "ALL";
    ensureDateDrivenMapScope();
    syncBottomMonthPills();
    scheduleTimelineRefresh(30);
  });

  document.getElementById("global-month-select")?.addEventListener("change", (e) => {
    GFIState.targetMonth = parseInt(e.target.value, 10);
    ensureDateDrivenMapScope();
    syncBottomMonthPills();
    scheduleTimelineRefresh(30);
  });

  document.getElementById("global-year-select")?.addEventListener("change", (e) => {
    GFIState.targetYear = parseInt(e.target.value, 10);
    ensureDateDrivenMapScope();
    syncBottomMonthPills();
    scheduleTimelineRefresh(30);
  });

  document.getElementById("cal-cell-display-mode")?.addEventListener("change", (e) => {
    GFIState.calendarDisplayMode = e.target.value;
    if (GFIState.overviewData) {
      renderBurningCalendarTable(
        "full-burning-calendar-table",
        GFIState.overviewData.calendar,
        GFIState.calendarDisplayMode
      );
    }
  });

  document.getElementById("analysis-year-a")?.addEventListener("change", (e) => {
    GFIState.analysisYearA = parseInt(e.target.value, 10);
    renderHistoricalAnalysisView();
  });

  document.getElementById("analysis-year-b")?.addEventListener("change", (e) => {
    GFIState.analysisYearB = parseInt(e.target.value, 10);
    renderHistoricalAnalysisView();
  });

  document.getElementById("btn-run-regional-comp")?.addEventListener("click", () => {
    GFIState.compRegionA = document.getElementById("comp-region-a").value;
    GFIState.compRegionB = document.getElementById("comp-region-b").value;
    loadAndRenderRegionalComparison();
  });

  document.getElementById("btn-quick-export-cal")?.addEventListener("click", () => {
    if (!navigator.onLine || API_BASE === null) {
      exportOfflineHotspotsCsv();
      return;
    }
    window.location.href = `${API_BASE}/api/export/calendar.csv?region_code=${encodeURIComponent(GFIState.regionCode)}&metric_mode=${encodeURIComponent(GFIState.metricMode)}`;
  });

  const triggerGeoJsonExport = () => {
    if (!navigator.onLine || API_BASE === null) {
      exportOfflineHotspotsGeoJson();
      return;
    }
    window.location.href = `${API_BASE}/api/export/hotspots.geojson?region_code=${encodeURIComponent(GFIState.regionCode)}`;
  };

  document.getElementById("btn-quick-export-geojson")?.addEventListener("click", triggerGeoJsonExport);

  const runWebCapture = async (fmt = "png") => {
    const m = GFIState.map.mainInstance;
    if (!m) return;

    const mimeMap = {
      png: { mime: "image/png", ext: "png", q: undefined },
      jpg: { mime: "image/jpeg", ext: "jpg", q: 0.92 },
      webp: { mime: "image/webp", ext: "webp", q: 0.92 },
    };
    const spec = mimeMap[fmt] || mimeMap.png;

    if (typeof window.html2canvas === "function") {
      try {
        const w = window.innerWidth;
        const h = window.innerHeight;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const out = document.createElement("canvas");
        out.width = Math.round(w * dpr);
        out.height = Math.round(h * dpr);
        const ctx = out.getContext("2d");

        if (spec.ext === "jpg") {
          ctx.fillStyle = "#04070d";
          ctx.fillRect(0, 0, out.width, out.height);
        }

        // 1. Force a fresh WebGL frame and copy it synchronously during 'render' before buffer clear
        await new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            const mapCanvas = m.getCanvas();
            if (mapCanvas) {
              ctx.drawImage(mapCanvas, 0, 0, out.width, out.height);
            }
            resolve();
          };
          m.once("render", finish);
          m.triggerRepaint();
          setTimeout(finish, 250);
        });

        // 2. Render all DOM UI (topbar, HUDs, timeline, modals) on top without any browser permission prompt
        const uiCanvas = await window.html2canvas(document.body, {
          backgroundColor: null,
          useCORS: true,
          allowTaint: true,
          logging: false,
          scale: dpr,
          width: w,
          height: h,
          ignoreElements: (el) => el.id === "choki-splash-overlay" || el.id === "map-main-gl" || el.id === "capture-format-modal" || el.id === "harmonized-export-modal",
          onclone: (clonedDoc) => {
            clonedDoc.documentElement.style.background = "transparent";
            clonedDoc.body.style.background = "transparent";
          },
        });
        ctx.drawImage(uiCanvas, 0, 0, out.width, out.height);

        const a = document.createElement("a");
        a.href = spec.q ? out.toDataURL(spec.mime, spec.q) : out.toDataURL(spec.mime);
        a.download = `choki_capture_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${spec.ext}`;
        a.click();
        return;
      } catch (_) {
        // Fallback to WebGL composite if DOM capture fails
      }
    }

    const exportCompositePng = () => {
      try {
        const srcCanvas = m.getCanvas();
        const w = srcCanvas.width || 1280;
        const h = srcCanvas.height || 720;
        const out = document.createElement("canvas");
        out.width = w;
        out.height = h;
        const ctx = out.getContext("2d");
        ctx.drawImage(srcCanvas, 0, 0, w, h);

        const dpr = Math.max(1, Math.min(2, w / 1280));
        const topH = Math.round(48 * dpr);
        const botH = Math.round(42 * dpr);

        // Top Branded NASA/Chokí Situational Banner
        const topGrad = ctx.createLinearGradient(0, 0, w, 0);
        topGrad.addColorStop(0, "rgba(127, 29, 29, 0.94)");
        topGrad.addColorStop(0.55, "rgba(69, 10, 10, 0.92)");
        topGrad.addColorStop(1, "rgba(11, 17, 30, 0.92)");
        ctx.fillStyle = topGrad;
        ctx.fillRect(0, 0, w, topH);
        ctx.fillStyle = "rgba(249, 115, 22, 0.85)";
        ctx.fillRect(0, topH - Math.max(2, Math.round(2 * dpr)), w, Math.max(2, Math.round(2 * dpr)));

        const now = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        const localTs = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
        const utcTs = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} UTC`;

        const regionLabel = document.getElementById("global-region-select")?.selectedOptions?.[0]?.textContent || GFIState.regionCode;
        const scopeVal = document.getElementById("map-time-scope")?.value || "SELECTED_MONTH";
        const scopeMap = { LIVE_24H: "24H NRT", LIVE_7D: "7D NRT", SELECTED_MONTH: `${GFIState.targetYear}-${pad(GFIState.targetMonth)}`, SELECTED_YEAR: `Year ${GFIState.targetYear}`, ALL_YEARS: "2001–2026 Archive" };
        const layersList = [];
        if (GFIState.map.layers?.clouds) layersList.push("GIBS Clouds");
        if (GFIState.map.layers?.topo) layersList.push("Topo Relief");
        const layerBadge = layersList.length ? ` • Layers: ${layersList.join(" + ")}` : "";

        ctx.fillStyle = "#ffffff";
        ctx.font = `700 ${Math.round(15 * dpr)}px Inter, system-ui, sans-serif`;
        ctx.fillText("CHOKÍ  •  HARMONIZED MODIS (1km) & VIIRS (375m) FIRE INTELLIGENCE", Math.round(16 * dpr), Math.round(22 * dpr));

        ctx.fillStyle = "#fde68a";
        ctx.font = `600 ${Math.round(11.5 * dpr)}px monospace`;
        ctx.fillText(`${regionLabel}  |  Window: ${scopeMap[scopeVal] || scopeVal}${layerBadge}`, Math.round(16 * dpr), Math.round(39 * dpr));

        // Top-right full Capture Date & Time
        ctx.textAlign = "right";
        ctx.fillStyle = "#f8fafc";
        ctx.font = `700 ${Math.round(12 * dpr)}px monospace`;
        ctx.fillText(`${localTs} LOCAL  |  ${utcTs}`, w - Math.round(16 * dpr), Math.round(29 * dpr));

        // Bottom Telemetry & FRP Legend Strip
        ctx.textAlign = "left";
        ctx.fillStyle = "rgba(9, 14, 26, 0.90)";
        ctx.fillRect(0, h - botH, w, botH);
        ctx.fillStyle = "rgba(56, 189, 248, 0.45)";
        ctx.fillRect(0, h - botH, w, Math.max(1, Math.round(1 * dpr)));

        const c = m.getCenter();
        const visibleCount = GFIState.hotspotsData?.summary?.returned_records ?? 0;
        ctx.fillStyle = "#e2e8f0";
        ctx.font = `600 ${Math.round(11.5 * dpr)}px monospace`;
        ctx.fillText(
          `Center: ${c.lat.toFixed(4)}°, ${c.lng.toFixed(4)}°  •  Zoom: ${m.getZoom().toFixed(2)}x  •  Active Hotspots: ${Number(visibleCount).toLocaleString()}`,
          Math.round(16 * dpr),
          h - Math.round(15 * dpr)
        );

        // Mini FRP Scale Legend on Bottom-Right
        const legW = Math.round(135 * dpr);
        const legH = Math.round(8 * dpr);
        const legX = w - legW - Math.round(18 * dpr);
        const legY = h - Math.round(22 * dpr);
        const frpGrad = ctx.createLinearGradient(legX, 0, legX + legW, 0);
        frpGrad.addColorStop(0, "#f59e0b");
        frpGrad.addColorStop(0.45, "#f97316");
        frpGrad.addColorStop(0.78, "#ef4444");
        frpGrad.addColorStop(1, "#fef08a");
        ctx.fillStyle = frpGrad;
        ctx.fillRect(legX, legY, legW, legH);
        ctx.fillStyle = "#cbd5e1";
        ctx.font = `600 ${Math.round(10 * dpr)}px monospace`;
        ctx.textAlign = "right";
        ctx.fillText("FRP MW: Low → Extreme", legX - Math.round(10 * dpr), h - Math.round(15 * dpr));

        const a = document.createElement("a");
        const fileTs = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        a.href = spec.q ? out.toDataURL(spec.mime, spec.q) : out.toDataURL(spec.mime);
        a.download = `choki-firms-${fileTs}.${spec.ext}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch (err) {
        console.warn("Capture failed:", err);
      }
    };

    m.once("render", exportCompositePng);
    m.triggerRepaint();
  };

  const capModal = document.getElementById("capture-format-modal");
  const closeCaptureModal = () => {
    if (capModal) capModal.style.display = "none";
  };

  document.getElementById("btn-capture-map")?.addEventListener("click", () => {
    if (capModal) {
      capModal.style.display = "flex";
    } else {
      runWebCapture("png");
    }
  });
  document.getElementById("btn-close-capture-modal")?.addEventListener("click", closeCaptureModal);
  capModal?.addEventListener("click", (e) => {
    if (e.target === capModal) closeCaptureModal();
  });
  capModal?.querySelectorAll("[data-capture-fmt]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const fmt = btn.getAttribute("data-capture-fmt") || "png";
      closeCaptureModal();
      setTimeout(() => runWebCapture(fmt), 60);
    });
  });
}

function updateNatureBadge() {
  const warnBanner = document.getElementById("unharmonized-warning-banner");
  if (warnBanner) {
    warnBanner.style.display = GFIState.metricMode === "raw_concatenated" ? "block" : "none";
  }
}

/* ==========================================================================
   2. DATA FETCHING & SYNCHRONIZATION
   ========================================================================== */

function populateRegionSelects(skipFly = false) {
  const selectors = [
    document.getElementById("global-region-select"),
    document.getElementById("comp-region-a"),
    document.getElementById("comp-region-b"),
  ];

  selectors.forEach((sel, idx) => {
    if (!sel) return;
    sel.innerHTML = "";
    if (idx === 0) {
      const globalOpt = document.createElement("option");
      globalOpt.value = "ALL";
      globalOpt.textContent = "🌍 Global Earth (All Regions + Live NASA FIRMS)";
      if (GFIState.regionCode === "ALL") globalOpt.selected = true;
      sel.appendChild(globalOpt);
    }
    GFIState.regions.forEach((reg) => {
      const opt = document.createElement("option");
      opt.value = reg.region_code;
      opt.textContent = `${reg.name} [${reg.region_code}]`;
      if (idx === 0 && reg.region_code === GFIState.regionCode) opt.selected = true;
      if (idx === 1 && reg.region_code === GFIState.compRegionA) opt.selected = true;
      if (idx === 2 && reg.region_code === GFIState.compRegionB) opt.selected = true;
      sel.appendChild(opt);
    });
  });

  if (!skipFly && !monitoredUserCoords) {
    syncMapCenterToRegion(GFIState.regionCode);
  }
}

function sanitizeHotspotsData(rawData, payload = null, applyPayloadFilter = false) {
  if (!rawData || !Array.isArray(rawData.hotspots)) return rawData;
  const nowD = new Date();
  const nowMaxMs = nowD.getTime();
  const todayUtcIso = nowD.toISOString().slice(0, 10);
  const list = rawData.hotspots;
  let needsFilter = applyPayloadFilter && Boolean(payload);

  // Fast pre-check: avoid allocating/parsing dates when all rows are strictly before today UTC
  if (!needsFilter) {
    for (let i = 0; i < list.length; i++) {
      const acqDate = list[i]?.acq_date;
      if (acqDate && acqDate >= todayUtcIso) {
        needsFilter = true;
        break;
      }
    }
    if (!needsFilter) return rawData;
  }

  const filtered = list.filter((r) => {
    const acqDate = r?.acq_date ? String(r.acq_date) : "";
    if (acqDate) {
      if (acqDate > todayUtcIso) return false;
      if (acqDate >= todayUtcIso && r?.source_provenance === "CALIBRATED_REFERENCE_SERIES") return false;
      if (acqDate === todayUtcIso && r.acq_time) {
        const parts = acqDate.split("-");
        if (parts.length === 3) {
          const rawT = String(r.acq_time).replace(":", "").padStart(4, "0");
          const acqMs = Date.UTC(
            parseInt(parts[0], 10),
            parseInt(parts[1], 10) - 1,
            parseInt(parts[2], 10),
            parseInt(rawT.slice(0, 2), 10) || 0,
            parseInt(rawT.slice(2, 4), 10) || 0,
            0
          );
          if (!isNaN(acqMs) && acqMs > nowMaxMs) return false;
        }
      }
    }
    if (!applyPayloadFilter || !payload) return true;
    if (payload.start_date && acqDate && acqDate < payload.start_date) return false;
    if (payload.end_date && acqDate && acqDate > payload.end_date) return false;
    if (!payload.start_date && !payload.end_date && payload.year && acqDate) {
      const yr = parseInt(acqDate.slice(0, 4), 10);
      if (yr !== payload.year) return false;
      if (payload.month) {
        const mo = parseInt(acqDate.slice(5, 7), 10);
        if (mo !== payload.month) return false;
      }
    }
    if (payload.instrument && payload.instrument !== "ALL" && r.instrument !== payload.instrument) return false;
    if (payload.satellite && payload.satellite !== "ALL" && r.satellite !== payload.satellite) return false;
    if (payload.min_frp && (parseFloat(r.frp_mw) || 0) < payload.min_frp) return false;
    if (payload.daynight && payload.daynight !== "ALL" && r.daynight !== payload.daynight) return false;
    return true;
  });

  if (filtered.length === list.length) {
    return { ...rawData, hotspots: filtered };
  }
  let modisCnt = 0;
  let viirsCnt = 0;
  let dayCnt = 0;
  let nightCnt = 0;
  let totalFrp = 0;
  const evIds = new Set();
  const dualIds = new Set();
  for (let i = 0; i < filtered.length; i++) {
    const r = filtered[i];
    if (r.instrument === "MODIS") modisCnt += 1;
    else viirsCnt += 1;
    if (r.daynight === "N") nightCnt += 1;
    else dayCnt += 1;
    totalFrp += Number(r.frp || 0);
    if (r.thermal_event_id) {
      evIds.add(r.thermal_event_id);
      if (r.event_sensor_composition === "DUAL_SENSOR_COINCIDENT") dualIds.add(r.thermal_event_id);
    }
  }
  return {
    ...rawData,
    hotspots: filtered,
    summary: {
      ...(rawData.summary || {}),
      returned_records: filtered.length,
      modis_detections: modisCnt,
      viirs_detections: viirsCnt,
      daynight_d: dayCnt,
      daynight_n: nightCnt,
      colocated_thermal_events: evIds.size,
      dual_sensor_coincident_events: dualIds.size,
      total_raw_frp_mw: Math.round(totalFrp * 100) / 100,
      mean_frp_mw: filtered.length ? Math.round((totalFrp / filtered.length) * 100) / 100 : 0,
    },
  };
}

async function hydrateInitialStateFromCache() {
  const [regRec, ovRec, hsRec] = await Promise.all([
    OfflineCache.get("regions_v1"),
    OfflineCache.get("overview_latest_v1"),
    OfflineCache.get("hotspots_latest_v1"),
  ]);

  if (regRec?.data?.regions && !GFIState.regions.length) {
    GFIState.regions = regRec.data.regions;
    populateRegionSelects(Boolean(monitoredUserCoords));
  }
  if (ovRec?.data && !GFIState.overviewData) {
    GFIState.overviewData = ovRec.data;
  }
  if (hsRec?.data && !GFIState.hotspotsData) {
    GFIState.hotspotsData = sanitizeHotspotsData(hsRec.data);
  }
  if (!GFIState.hotspotsData || !GFIState.overviewData) {
    const fb = await getStaticFallback();
    if (fb) {
      if (!GFIState.regions.length && fb.regions) {
        GFIState.regions = fb.regions;
        populateRegionSelects(Boolean(monitoredUserCoords));
      }
      if (!GFIState.overviewData && fb.overview) GFIState.overviewData = fb.overview;
      if (!GFIState.hotspotsData && fb.hotspots) GFIState.hotspotsData = sanitizeHotspotsData(fb.hotspots);
    }
  }
}

async function loadRegionsList(opts = {}) {
  try {
    const res = await apiFetch("/api/regions");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rawData = await res.json();
    const data = sanitizeHotspotsData(rawData);
    GFIState.regions = data.regions || [];
    OfflineCache.set("regions_v1", data).catch(() => {});
  } catch (_) {
    const cached = await OfflineCache.get("regions_v1");
    if (cached?.data?.regions) {
      GFIState.regions = cached.data.regions;
      updateConnectivityHud(true);
    } else {
      const fb = await getStaticFallback();
      if (fb?.regions) {
        GFIState.regions = fb.regions;
        updateConnectivityHud(true);
      }
    }
  }
  populateRegionSelects(Boolean(opts.skipFly));
}

function syncMapCenterToRegion(regionCode) {
  if (regionCode === "ALL") {
    GFIState.map.centerLat = 15.0;
    GFIState.map.centerLon = -30.0;
    GFIState.map.zoom = 1.9;
    ["bbox-min-lat", "bbox-max-lat", "bbox-min-lon", "bbox-max-lon"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    const flyOpts = { center: [-30.0, 15.0], zoom: 1.9, pitch: 10, duration: 1400 };
    GFIState.map.overviewInstance?.flyTo(flyOpts);
    GFIState.map.mainInstance?.flyTo(flyOpts);
    return;
  }

  const reg = GFIState.regions.find((r) => r.region_code === regionCode);
  if (!reg) return;
  GFIState.map.centerLat = reg.center_lat;
  GFIState.map.centerLon = reg.center_lon;
  GFIState.map.zoom = Math.max(3.5, (reg.default_zoom || 6.0) - 0.8);

  document.getElementById("bbox-min-lat").value = reg.min_lat;
  document.getElementById("bbox-max-lat").value = reg.max_lat;
  document.getElementById("bbox-min-lon").value = reg.min_lon;
  document.getElementById("bbox-max-lon").value = reg.max_lon;

  const flyOpts = {
    center: [reg.center_lon, reg.center_lat],
    zoom: GFIState.map.zoom,
    pitch: 22,
    duration: 1400,
  };
  GFIState.map.overviewInstance?.flyTo({ ...flyOpts, zoom: Math.max(2.6, GFIState.map.zoom - 1.2) });
  GFIState.map.mainInstance?.flyTo(flyOpts);
}

function renderAllOverviewWidgets() {
  if (!GFIState.overviewData) return;
  renderOverviewDashboard();
  renderBurningCalendarTable(
    "overview-calendar-table",
    GFIState.overviewData.calendar,
    "value"
  );
  renderBurningCalendarTable(
    "full-burning-calendar-table",
    GFIState.overviewData.calendar,
    GFIState.calendarDisplayMode
  );
  renderCalendarDetailPanel();
  renderHistoricalAnalysisView();
}

const _HOTSPOTS_CLIENT_CACHE = new Map();
const _OVERVIEW_CLIENT_CACHE = new Map();
let _lastOverviewKey = "";
let _hotspotsAbortCtrl = null;
let _hotspotsQuerySeq = 0;

function clearClientDataCaches() {
  _HOTSPOTS_CLIENT_CACHE.clear();
  _OVERVIEW_CLIENT_CACHE.clear();
  _lastOverviewKey = "";
}

async function refreshAllActiveData(opts = {}) {
  const ovKey = `${GFIState.regionCode}:${GFIState.metricMode}:${GFIState.targetYear}:${GFIState.targetMonth}`;
  const needOverview = Boolean(opts.forceOverview) || !GFIState.overviewData || ovKey !== _lastOverviewKey;

  let overviewPromise = Promise.resolve(false);
  if (needOverview) {
    const qs = new URLSearchParams({
      region_code: GFIState.regionCode,
      metric_mode: GFIState.metricMode,
      target_year: String(GFIState.targetYear),
      target_month: String(GFIState.targetMonth),
    });
    overviewPromise = (async () => {
      const memCached = !opts.forceOverview ? _OVERVIEW_CLIENT_CACHE.get(ovKey) : null;
      if (memCached) {
        GFIState.overviewData = memCached;
        _lastOverviewKey = ovKey;
        return true;
      }
      try {
        const res = await apiFetch(`/api/overview?${qs.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        GFIState.overviewData = data;
        _lastOverviewKey = ovKey;
        if (_OVERVIEW_CLIENT_CACHE.size >= 24) {
          _OVERVIEW_CLIENT_CACHE.delete(_OVERVIEW_CLIENT_CACHE.keys().next().value);
        }
        _OVERVIEW_CLIENT_CACHE.set(ovKey, data);
        OfflineCache.set("overview_latest_v1", data).catch(() => {});
        return true;
      } catch (_) {
        const cached = await OfflineCache.get("overview_latest_v1");
        if (cached?.data) {
          GFIState.overviewData = cached.data;
          updateConnectivityHud(true);
          return true;
        }
        const fb = await getStaticFallback();
        if (fb?.overview) {
          GFIState.overviewData = fb.overview;
          updateConnectivityHud(true);
          return true;
        }
        return false;
      }
    })();
  }

  const [didUpdateOverview] = await Promise.all([
    overviewPromise,
    loadSpatialHotspots(opts),
  ]);

  if (didUpdateOverview) {
    renderAllOverviewWidgets();
  }
}

function buildHotspotsQueryPayload() {
  const inst = document.getElementById("map-filter-instrument")?.value || "ALL";
  const sat = document.getElementById("map-filter-satellite")?.value || "ALL";
  const conf = document.getElementById("map-filter-confidence")?.value || "Nominal";
  const minFrp = parseFloat(document.getElementById("map-filter-frp")?.value || "0");
  const dn = document.getElementById("map-filter-daynight")?.value || "ALL";
  const timeScope = document.getElementById("map-time-scope")?.value || "SELECTED_MONTH";

  const payload = {
    region_code: GFIState.regionCode,
    instrument: inst,
    satellite: sat,
    min_confidence_tier: conf,
    min_frp: minFrp,
    daynight: dn,
    limit: GFIState.regionCode === "ALL" ? 20000 : 10000,
  };

  const fmtIsoLocalDate = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  if (timeScope === "LIVE_24H") {
    const endD = new Date();
    const startD = new Date(endD.getTime() - 24 * 3600000);
    payload.start_date = fmtIsoLocalDate(startD);
    payload.end_date = fmtIsoLocalDate(endD);
  } else if (timeScope === "LIVE_7D" || timeScope === "LIVE_FIRMS_ONLY") {
    const endD = new Date();
    const startD = new Date(endD.getTime() - 7 * 24 * 3600000);
    payload.start_date = fmtIsoLocalDate(startD);
    payload.end_date = fmtIsoLocalDate(endD);
  } else if (timeScope === "SELECTED_YEAR") {
    payload.year = GFIState.targetYear;
  } else if (timeScope === "SELECTED_MONTH") {
    payload.year = GFIState.targetYear;
    payload.month = GFIState.targetMonth;
    if (GFIState.targetDay && GFIState.targetDay !== "ALL") {
      const maxDays = new Date(GFIState.targetYear, GFIState.targetMonth, 0).getDate();
      const clampedDay = Math.min(maxDays, Math.max(1, parseInt(GFIState.targetDay, 10) || 1));
      const exactDate = `${GFIState.targetYear}-${String(GFIState.targetMonth).padStart(2, "0")}-${String(clampedDay).padStart(2, "0")}`;
      payload.start_date = exactDate;
      payload.end_date = exactDate;
    }
  }

  if (GFIState.map.polygonPoints && GFIState.map.polygonPoints.length >= 3) {
    payload.polygon_coords = GFIState.map.polygonPoints;
  } else if (GFIState.map.customBBox) {
    payload.min_lat = GFIState.map.customBBox.minLat;
    payload.max_lat = GFIState.map.customBBox.maxLat;
    payload.min_lon = GFIState.map.customBBox.minLon;
    payload.max_lon = GFIState.map.customBBox.maxLon;
  }
  return { payload, minFrp, dn, timeScope };
}

function cacheHotspotResponse(cacheKey, data) {
  const todayUtcIso = new Date().toISOString().slice(0, 10);
  try {
    const p = JSON.parse(cacheKey);
    if ((!p.end_date || p.end_date >= todayUtcIso) && !(data?.hotspots?.length > 0)) {
      return;
    }
  } catch (_) {}
  if (_HOTSPOTS_CLIENT_CACHE.size >= 24) {
    _HOTSPOTS_CLIENT_CACHE.delete(_HOTSPOTS_CLIENT_CACHE.keys().next().value);
  }
  _HOTSPOTS_CLIENT_CACHE.set(cacheKey, data);
}

function prefetchPreviousDayHotspots(basePayload) {
  if (!navigator.onLine || !basePayload?.start_date || basePayload.start_date !== basePayload.end_date) return;
  const parts = String(basePayload.start_date).split("-").map((n) => parseInt(n, 10));
  if (parts.length !== 3) return;
  const prevDt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] - 1));
  if (prevDt.getUTCFullYear() < 2001) return;
  const prevIso = `${prevDt.getUTCFullYear()}-${String(prevDt.getUTCMonth() + 1).padStart(2, "0")}-${String(prevDt.getUTCDate()).padStart(2, "0")}`;
  const prevPayload = {
    ...basePayload,
    year: prevDt.getUTCFullYear(),
    month: prevDt.getUTCMonth() + 1,
    start_date: prevIso,
    end_date: prevIso,
  };
  const key = JSON.stringify(prevPayload);
  if (_HOTSPOTS_CLIENT_CACHE.has(key)) return;
  setTimeout(async () => {
    try {
      const res = await apiFetch("/api/hotspots/query", {
        method: "POST",
        body: key,
      });
      if (!res.ok) return;
      const rawData = await res.json();
      cacheHotspotResponse(key, sanitizeHotspotsData(rawData));
    } catch (_) {}
  }, 90);
}

async function loadSpatialHotspots(opts = {}) {
  const { payload, minFrp, dn, timeScope } = buildHotspotsQueryPayload();
  const payloadKey = JSON.stringify(payload);
  const querySeq = ++_hotspotsQuerySeq;

  const memHit = !opts.forceFetch ? _HOTSPOTS_CLIENT_CACHE.get(payloadKey) : null;
  if (memHit) {
    _HOTSPOTS_CLIENT_CACHE.delete(payloadKey);
    _HOTSPOTS_CLIENT_CACHE.set(payloadKey, memHit);
    _lastHotspotsMapRef = null;
    GFIState.hotspotsData = memHit;
    if (!opts.skipMapPush) {
      updateMapLibreData();
      renderMapSummaryBox();
      if (GFIState.map.layers?.clouds) {
        syncEnvironmentalLayers();
      }
    }
    if (timeScope === "SELECTED_MONTH" && payload.start_date) {
      prefetchPreviousDayHotspots(payload);
    }
    return;
  }

  if (_hotspotsAbortCtrl) {
    try { _hotspotsAbortCtrl.abort(); } catch (_) {}
  }
  _hotspotsAbortCtrl = typeof AbortController !== "undefined" ? new AbortController() : null;

  try {
    const res = await apiFetch("/api/hotspots/query", {
      method: "POST",
      body: payloadKey,
      signal: _hotspotsAbortCtrl?.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rawData = await res.json();
    if (querySeq !== _hotspotsQuerySeq) return;
    const data = sanitizeHotspotsData(rawData);
    cacheHotspotResponse(payloadKey, data);
    GFIState.hotspotsData = null;
    _lastHotspotsMapRef = null;
    GFIState.hotspotsData = data;
    const todayUtcIso = new Date().toISOString().slice(0, 10);
    const isTodayLiveQuery = !payload.end_date || payload.end_date >= todayUtcIso;
    const syncInfo = rawData?.nrt_sync;
    const retryAttempt = Number(opts._nrtRetryAttempt || 0);
    if (
      isTodayLiveQuery &&
      (data.hotspots || []).length === 0 &&
      navigator.onLine &&
      syncInfo &&
      (syncInfo.syncing || syncInfo.last_sync_epoch === 0) &&
      retryAttempt < 8
    ) {
      setTimeout(() => {
        if (querySeq === _hotspotsQuerySeq) {
          loadSpatialHotspots({ ...opts, forceFetch: true, _nrtRetryAttempt: retryAttempt + 1 });
        }
      }, 3500);
    }
    if (!payload.polygon_coords && !payload.min_lat && minFrp === 0 && dn === "ALL") {
      // Extract tiny 600-item offline snapshot immediately so setTimeout closure NEVER retains full array in RAM
      const lightSnap = {
        summary: data.summary,
        spatial_clusters: [],
        hotspots: (data.hotspots || []).slice(0, 600),
      };
      setTimeout(() => {
        OfflineCache.set("hotspots_latest_v1", lightSnap).catch(() => {});
      }, 2500);
    }
    if (timeScope === "SELECTED_MONTH" && payload.start_date) {
      prefetchPreviousDayHotspots(payload);
    }
  } catch (err) {
    if (err?.name === "AbortError" || querySeq !== _hotspotsQuerySeq) return;
    const cached = await OfflineCache.get("hotspots_latest_v1");
    const fb = await getStaticFallback();
    const baseData = cached?.data?.hotspots?.length ? cached.data : fb?.hotspots;
    if (baseData) {
      GFIState.hotspotsData = sanitizeHotspotsData(baseData, payload, true);
      updateConnectivityHud(true);
    }
  }

  if (querySeq !== _hotspotsQuerySeq) return;
  if (!opts.skipMapPush) {
    updateMapLibreData();
    renderMapSummaryBox();
    if (GFIState.map.layers?.clouds) {
      syncEnvironmentalLayers();
    }
  }
}

/* ==========================================================================
   3. OVERVIEW DASHBOARD & FLAGSHIP ANOMALY CARD
   ========================================================================== */

function renderOverviewDashboard() {
  const data = GFIState.overviewData;
  if (!data) return;

  const comp = data.month_comparison;
  const card = comp.indicator_card;
  const sb = card.sensor_breakdown;
  const diag = data.calendar.trend_diagnostics;

  const setTxt = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  setTxt("kpi-period-tag", `${MONTH_SHORT[comp.target_month - 1]} ${comp.target_year}`);
  setTxt("kpi-month-activity", formatNum(card.month_activity));

  const sign = card.difference_pct >= 0 ? "+" : "";
  setTxt("kpi-anomaly-pct", `${sign}${card.difference_pct}%`);

  const pBadge = document.getElementById("kpi-percentile-badge");
  if (pBadge) {
    pBadge.textContent = `P${card.historical_percentile}`;
    pBadge.className = `anomaly-badge anom-sev-${card.severity}`;
  }

  setTxt(
    "overview-anomaly-subtitle",
    `${comp.target_month_name} ${comp.target_year} vs ${card.total_years_evaluated}-Yr Baseline • ${data.calendar.region.name}`
  );
  setTxt("overlay-active-region-badge", data.calendar.region.name || "Global");

  const calYears = data.calendar.calendar_years || [];
  const monthBaseline = (data.calendar.monthly_baselines || []).find((b) => b.month === comp.target_month);
  let peakAnn = null;
  let lowAnn = null;
  calYears.forEach((yr) => {
    const val = Number(yr.annual_harmonized_cal || 0);
    if (!peakAnn || val > peakAnn.val) peakAnn = { year: yr.year, val };
    if (!lowAnn || (val > 0 && val < lowAnn.val)) lowAnn = { year: yr.year, val };
  });
  const peakSeason = (data.fingerprint?.peak_season_months || []).join(", ") || "—";
  const trendSlope = diag?.harmonized_theil_sen_slope_per_yr ?? 0;
  const trendSign = trendSlope >= 0 ? "+" : "";

  const tbody = document.getElementById("overview-anomaly-tbody");
  if (tbody) {
    tbody.innerHTML = `
      <tr><td>Historical Median</td><td class="mono-val">${formatNum(card.historical_month_median)}</td></tr>
      <tr><td>Percentile (Z_MAD)</td><td class="mono-val">P${card.historical_percentile} (${card.robust_z_score})</td></tr>
      <tr><td>Status</td><td class="mono-val"><span class="anomaly-badge anom-sev-${card.severity}">${card.classification_label}</span></td></tr>
      ${
        monthBaseline
          ? `<tr><td>${MONTH_SHORT[comp.target_month - 1]} Record High / Low</td><td class="mono-val"><span style="color:#fb923c;">${monthBaseline.max_year} (${formatNum(monthBaseline.max_val)})</span> / <span style="color:#38bdf8;">${monthBaseline.min_year} (${formatNum(monthBaseline.min_val)})</span></td></tr>`
          : ""
      }
      ${
        peakAnn && lowAnn
          ? `<tr><td>26-Yr Annual Peak / Low</td><td class="mono-val"><span style="color:#fb923c;">${peakAnn.year}</span> / <span style="color:#38bdf8;">${lowAnn.year}</span></td></tr>`
          : ""
      }
      <tr><td>Peak Season</td><td class="mono-val">${escapeHtml(peakSeason)}</td></tr>
      <tr><td>26-Yr Trend (Theil-Sen)</td><td class="mono-val">${trendSign}${trendSlope}/yr</td></tr>
    `;
  }

  const provBox = document.getElementById("overview-provenance-split");
  if (provBox) {
    provBox.innerHTML = `
      <div class="qc-mini-stat"><span class="qc-mini-val" style="color:#38bdf8;">${formatInt(sb.raw_modis_total)}</span><span class="qc-mini-lbl">MODIS</span></div>
      <div class="qc-mini-stat"><span class="qc-mini-val" style="color:#fb923c;">${formatInt(sb.raw_viirs_total)}</span><span class="qc-mini-lbl">VIIRS</span></div>
      <div class="qc-mini-stat"><span class="qc-mini-val" style="color:#c084fc;">${formatInt(sb.colocated_events)}</span><span class="qc-mini-lbl">Co-located</span></div>
    `;
  }

  setTxt(
    "overview-epoch-diagnostics",
    `Post-2012 Unharmonized Sum Jump: +${diag.naive_concat_artificial_jump_pct}% (Sensor Bias) vs Harmonized Series: ${diag.harmonized_epoch_change_pct >= 0 ? '+' : ''}${diag.harmonized_epoch_change_pct}%`
  );

  drawHarmonizationProofChart("chart-overview-harmonization-proof", data.calendar.calendar_years);
}

function renderOverviewCharts() {
  const data = GFIState.overviewData;
  if (!data) return;

  // 1. Same-Month Historical Bar Chart (e.g. All Augusts 2001-2026)
  const comp = data.month_comparison;
  drawSameMonthBarChart(
    "chart-overview-month-history",
    comp.same_month_history,
    comp.indicator_card.historical_month_median,
    comp.indicator_card.historical_p90
  );

  // 2. Harmonization Proof Chart (Annual 2001-2026: Raw MODIS, Raw Concatenated, Harmonized Calibrated)
  drawHarmonizationProofChart(
    "chart-overview-harmonization-proof",
    data.calendar.calendar_years
  );
}

/* ==========================================================================
   4. BURNING CALENDAR MATRIX & INTERACTIVE CELL SELECTION
   ========================================================================== */

function getThermalCellColor(ratio, anomalySeverity) {
  if (ratio === null || ratio === undefined) return "rgba(15, 25, 45, 0.5)";
  if (anomalySeverity >= 4 || ratio >= 0.88) return "#dc2626"; // Extreme Crimson
  if (anomalySeverity === 3 || ratio >= 0.68) return "#ea580c"; // High Thermal Orange
  if (ratio >= 0.45) return "#d97706"; // Moderate Amber
  if (ratio >= 0.26) return "#2a6f97"; // Nominal Ocean Blue
  if (ratio >= 0.12) return "#1b4965"; // Low Slate Blue
  return "#0f243c"; // Minimal Deep Navy
}

function renderBurningCalendarTable(tableId, calendarData, displayMode) {
  const table = document.getElementById(tableId);
  if (!table || !calendarData) return;

  let html = `<thead><tr><th>Year</th>`;
  MONTH_SHORT.forEach((mName) => {
    html += `<th>${mName}</th>`;
  });
  html += `<th>Annual Total</th></tr></thead><tbody>`;

  const yearsList = calendarData.calendar_years || [];
  yearsList.forEach((yrRow) => {
    const y = yrRow.year;
    html += `<tr><td class="year-label">${y}</td>`;
    for (let m = 1; m <= 12; m++) {
      const cell = yrRow.months[m] || yrRow.months[String(m)];
      if (!cell || !cell.available) {
        html += `<td class="cal-cell" style="background:#09101d; color:#475569;" title="${cell?.unavailable_reason || 'Unavailable'}">—</td>`;
        continue;
      }

      const bg = getThermalCellColor(cell.intensity_ratio, cell.anomaly_severity);
      const isSelected = y === GFIState.targetYear && m === GFIState.targetMonth;
      const hasAnomDot = cell.anomaly_severity >= 3;

      let textVal = Math.round(cell.value);
      if (displayMode === "pct_anomaly") {
        const s = cell.pct_anomaly >= 0 ? "+" : "";
        textVal = `${s}${Math.round(cell.pct_anomaly)}%`;
      } else if (displayMode === "percentile") {
        textVal = `P${Math.round(cell.percentile)}`;
      }

      const tooltip = [
        `${cell.month_name} ${y} [${cell.active_sensors}]`,
        `Value (${calendarData.metric_mode}): ${cell.value}`,
        `${cell.month_name} Historical Median: ${cell.month_median}`,
        `Anomaly vs Median: ${cell.pct_anomaly >= 0 ? '+' : ''}${cell.pct_anomaly}% (P${cell.percentile})`,
        `Raw MODIS: ${cell.raw_modis} | Raw VIIRS: ${cell.raw_viirs}`,
        `Classification: ${cell.anomaly_label}`,
      ].join("\n");

      html += `<td class="cal-cell ${isSelected ? 'selected-cell' : ''} ${hasAnomDot ? 'anom-marker' : ''}"
                   style="background:${bg}; color:#f8fafc;"
                   data-year="${y}" data-month="${m}"
                   title="${tooltip}">${textVal}</td>`;
    }
    html += `<td class="year-label" style="color:var(--accent-cyan);">${ formatInt(Math.round(yrRow.annual_total)) }</td></tr>`;
  });

  html += `</tbody>`;
  table.innerHTML = html;

  // Bind click events on all calendar cells
  table.querySelectorAll(".cal-cell[data-year]").forEach((td) => {
    td.addEventListener("click", async () => {
      const y = parseInt(td.getAttribute("data-year"), 10);
      const m = parseInt(td.getAttribute("data-month"), 10);
      GFIState.targetYear = y;
      GFIState.targetMonth = m;
      document.getElementById("global-year-select").value = String(y);
      document.getElementById("global-month-select").value = String(m);
      await refreshAllActiveData();
    });
  });
}

function renderCalendarDetailPanel() {
  const data = GFIState.overviewData;
  if (!data) return;

  const comp = data.month_comparison;
  const card = comp.indicator_card;
  const sb = card.sensor_breakdown;

  document.getElementById("cal-detail-title").textContent =
    `Seasonal Analysis: ${comp.target_month_name} ${comp.target_year}`;

  const sign = card.difference_pct >= 0 ? "+" : "";
  document.getElementById("cal-selected-cell-details").innerHTML = `
    <div class="sci-callout" style="margin-bottom:8px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
        <strong>${comp.target_month_name} ${comp.target_year} vs. All ${comp.target_month_name}s (2001–2026)</strong>
        <span class="anomaly-badge anom-sev-${card.severity}">${card.classification_label}</span>
      </div>
      • <strong>Selected Activity:</strong> <code>${formatNum(card.month_activity)}</code><br/>
      • <strong>${comp.target_month_name} Historical Median:</strong> <code>${formatNum(card.historical_month_median)}</code> (IQR: ${formatNum(card.historical_month_iqr)})<br/>
      • <strong>Seasonal Deviation:</strong> <code>${sign}${card.difference_pct}%</code> | <strong>Percentile:</strong> <code>P${card.historical_percentile}</code> | <strong>Z_MAD:</strong> <code>${card.robust_z_score}</code><br/>
      • <strong>Sensor Provenance:</strong> MODIS=${sb.raw_modis_total} px, VIIRS=${sb.raw_viirs_total} px, Co-located Events=${sb.colocated_events}
    </div>
  `;

  renderCalendarSameMonthChart();

  // Render Monthly Baselines Summary Table (Months 1..12)
  const baseTable = document.getElementById("cal-monthly-baselines-table");
  if (baseTable) {
    let bHtml = `<thead><tr>
      <th>Month</th><th>Median</th><th>Mean</th><th>IQR</th><th>P90</th><th>Max (Year)</th>
    </tr></thead><tbody>`;
    data.calendar.monthly_baselines.forEach((b) => {
      const highlight = b.month === comp.target_month ? 'style="background:rgba(0,191,255,0.12);"' : "";
      bHtml += `<tr ${highlight}>
        <td><strong>${b.month_short}</strong></td>
        <td>${formatNum(b.median)}</td>
        <td>${formatNum(b.mean)}</td>
        <td>${formatNum(b.iqr)}</td>
        <td>${formatNum(b.p90)}</td>
        <td>${formatNum(b.max_val)} (${b.max_year})</td>
      </tr>`;
    });
    bHtml += `</tbody>`;
    baseTable.innerHTML = bHtml;
  }
}

function renderCalendarSameMonthChart() {
  if (!GFIState.overviewData) return;
  const comp = GFIState.overviewData.month_comparison;
  drawSameMonthBarChart(
    "chart-calendar-same-month",
    comp.same_month_history,
    comp.indicator_card.historical_month_median,
    comp.indicator_card.historical_p90
  );
}

/* ==========================================================================
   5. MAPLIBRE GL v5 3D GLOBE & GEOSPATIAL ENGINE (SATELLITE, CLUSTERS, BBOX, POLYGON)
   ========================================================================== */

function buildMapLibreStyle(basemapMode) {
  const isSat = basemapMode === "satellite";

  if (isSat) {
    // 100% free, zero-API-key Satellite Imagery + Boundaries/Places (labels load at zoom >= 4 for fast globe spin)
    return {
      version: 8,
      sources: {
        "esri-satellite": {
          type: "raster",
          tiles: [
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          ],
          tileSize: 256,
          maxzoom: 17,
          attribution: "Esri World Imagery",
        },
        "esri-labels": {
          type: "raster",
          tiles: [
            "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
          ],
          tileSize: 256,
          minzoom: 4,
          maxzoom: 16,
        },
      },
      layers: [
        { id: "bg-space", type: "background", paint: { "background-color": "#030710" } },
        { id: "base-layer", type: "raster", source: "esri-satellite", paint: { "raster-opacity": 0.94, "raster-fade-duration": 0 } },
        { id: "labels-layer", type: "raster", source: "esri-labels", minzoom: 4, paint: { "raster-opacity": 0.85, "raster-fade-duration": 0 } },
      ],
    };
  }

  // Esri World Dark Gray Canvas + Reference Labels (Zero API key required, zero watermarks, cached in SW)
  return {
    version: 8,
    sources: {
      "esri-dark-base": {
        type: "raster",
        tiles: [
          "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
        ],
        tileSize: 256,
        maxzoom: 16,
        attribution: "Esri, HERE, Garmin, © OpenStreetMap",
      },
      "esri-dark-labels": {
        type: "raster",
        tiles: [
          "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
        ],
        tileSize: 256,
        minzoom: 3,
        maxzoom: 16,
      },
    },
    layers: [
      { id: "bg-space", type: "background", paint: { "background-color": "#050912" } },
      {
        id: "base-layer",
        type: "raster",
        source: "esri-dark-base",
        paint: {
          "raster-opacity": 0.98,
          "raster-contrast": 0.18,
          "raster-brightness-max": 0.85,
          "raster-fade-duration": 0,
        },
      },
      {
        id: "dark-labels-layer",
        type: "raster",
        source: "esri-dark-labels",
        minzoom: 3,
        paint: {
          "raster-opacity": 0.88,
          "raster-fade-duration": 0,
        },
      },
    ],
  };
}

function addHotspotSourcesAndLayers(mapInstance, isCompact) {
  if (!mapInstance.getSource("hotspots-src")) {
    mapInstance.addSource("hotspots-src", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      cluster: false,
      maxzoom: 9,
      tolerance: 0.5,
      buffer: 16,
    });
  }
  if (!mapInstance.getSource("selection-src")) {
    mapInstance.addSource("selection-src", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }

  // 1. GPU WebGL Thermal Radiance Heatmap Cloud (Glowing Fire Plumes)
  if (!mapInstance.getLayer("thermal-heatmap")) {
    mapInstance.addLayer({
      id: "thermal-heatmap",
      type: "heatmap",
      source: "hotspots-src",
      maxzoom: 12,
      paint: {
        "heatmap-weight": [
          "interpolate",
          ["linear"],
          ["coalesce", ["get", "frp"], 20],
          0, 0.15,
          40, 0.55,
          150, 1.0,
        ],
        "heatmap-intensity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          2, 0.65,
          6, 1.25,
          10, 1.8,
        ],
        "heatmap-color": [
          "interpolate",
          ["linear"],
          ["heatmap-density"],
          0.0, "rgba(0, 0, 0, 0)",
          0.12, "rgba(234, 88, 12, 0.22)",
          0.32, "rgba(249, 115, 22, 0.52)",
          0.55, "rgba(239, 68, 68, 0.72)",
          0.78, "rgba(250, 204, 21, 0.86)",
          1.0, "rgba(254, 249, 195, 0.95)",
        ],
        "heatmap-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          2, 12,
          5, 22,
          8, 30,
          11, 20,
        ],
        "heatmap-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          3, 0.88,
          9, 0.65,
          12, 0.15,
        ],
      },
    });
  }

  // 2. Soft Infrared Glow Halo around Individual Detections
  if (!mapInstance.getLayer("hotspots-glow")) {
    mapInstance.addLayer({
      id: "hotspots-glow",
      type: "circle",
      source: "hotspots-src",
      paint: {
        "circle-color": [
          "match",
          ["get", "instrument"],
          "MODIS", "rgba(56, 189, 248, 0.55)",
          "VIIRS", "rgba(249, 115, 22, 0.55)",
          "rgba(192, 132, 252, 0.55)",
        ],
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          3, 4.5,
          6, 8.5,
          10, 16,
        ],
        "circle-blur": 0.85,
        "circle-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          3, 0.35,
          7, 0.65,
          10, 0.8,
        ],
      },
    });
  }

  // 3. Precision Sensor Cores (MODIS 1km vs VIIRS 375m, visible at all zooms with zero numbered circles)
  if (!mapInstance.getLayer("unclustered-hotspots")) {
    mapInstance.addLayer({
      id: "unclustered-hotspots",
      type: "circle",
      source: "hotspots-src",
      paint: {
        "circle-color": [
          "match",
          ["get", "instrument"],
          "MODIS", "#38bdf8",
          "VIIRS", "#fb923c",
          "#10b981",
        ],
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          2, 1.4,
          5, ["match", ["get", "instrument"], "MODIS", 2.8, 1.8],
          8, ["match", ["get", "instrument"], "MODIS", 5.2, 3.1],
          11, ["match", ["get", "instrument"], "MODIS", 9.0, 5.0],
        ],
        "circle-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          3, 0.55,
          6, 0.88,
        ],
        "circle-stroke-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          5, 0.0,
          8, 0.9,
        ],
        "circle-stroke-color": "rgba(255, 255, 255, 0.85)",
      },
    });
  }

  // Selection BBox / Polygon overlay
  if (!mapInstance.getLayer("selection-fill")) {
    mapInstance.addLayer({
      id: "selection-fill",
      type: "fill",
      source: "selection-src",
      paint: { "fill-color": "#00bfff", "fill-opacity": 0.16 },
    });
    mapInstance.addLayer({
      id: "selection-line",
      type: "line",
      source: "selection-src",
      paint: { "line-color": "#00bfff", "line-width": 2 },
    });
  }

  // NASA FIRMS Click-Radius Zone Circle (purple fill + yellow border)
  if (!mapInstance.getSource("click-radius-src")) {
    mapInstance.addSource("click-radius-src", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    mapInstance.addLayer({
      id: "click-radius-fill",
      type: "fill",
      source: "click-radius-src",
      paint: { "fill-color": "#6d28d9", "fill-opacity": 0.35 },
    });
    mapInstance.addLayer({
      id: "click-radius-line",
      type: "line",
      source: "click-radius-src",
      paint: { "line-color": "#facc15", "line-width": 2.2 },
    });
  }

  // Persistent User GPS Monitoring Beacon (visible online & offline)
  if (!mapInstance.getSource("user-location-src")) {
    mapInstance.addSource("user-location-src", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    mapInstance.addLayer({
      id: "user-location-halo",
      type: "circle",
      source: "user-location-src",
      paint: {
        "circle-color": "rgba(56, 189, 248, 0.16)",
        "circle-stroke-width": 1.6,
        "circle-stroke-color": "rgba(56, 189, 248, 0.78)",
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          2, 10,
          6, 26,
          10, 44,
        ],
      },
    });
    mapInstance.addLayer({
      id: "user-location-core",
      type: "circle",
      source: "user-location-src",
      paint: {
        "circle-color": "#38bdf8",
        "circle-radius": 5.5,
        "circle-stroke-width": 2.2,
        "circle-stroke-color": "#ffffff",
      },
    });
  }

  if (!isCompact && !mapInstance.getSource("measure-src")) {
    mapInstance.addSource("measure-src", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    mapInstance.addLayer({
      id: "measure-line",
      type: "line",
      source: "measure-src",
      paint: { "line-color": "#10b981", "line-width": 2.5, "line-dasharray": [3, 2] },
    });
    mapInstance.addLayer({
      id: "measure-pts",
      type: "circle",
      source: "measure-src",
      filter: ["==", "$type", "Point"],
      paint: { "circle-color": "#10b981", "circle-radius": 4.5, "circle-stroke-width": 1.8, "circle-stroke-color": "#ffffff" },
    });
  }

  if (!isCompact) {
    applyMapVisualLayerMode();
  }
}

let _nasaCloudsProtocolRegistered = false;
let _cloudProcessCanvas = null;
let _cloudProcessCtx = null;

function registerNasaCloudsProtocol() {
  if (_nasaCloudsProtocolRegistered || typeof maplibregl === "undefined" || !maplibregl.addProtocol) return;
  _nasaCloudsProtocolRegistered = true;

  maplibregl.addProtocol("nasaclouds", async (params, abortController) => {
    // URL format: nasaclouds://YYYY-MM-DD/{z}/{y}/{x}
    const raw = params.url.replace(/^nasaclouds:\/\//, "");
    const parts = raw.split("/");
    const reqDate = parts[0] || "2026-11-13";
    const z = parts[1] || "0";
    const y = parts[2] || "0";
    const x = parts[3] || "0";

    const yr = parseInt(reqDate.slice(0, 4), 10) || 2026;
    // VIIRS NOAA-20 has a 3,040 km swath (zero equatorial orbital gaps) from 2018+; MODIS Terra covers 2001-2017
    const primaryLayer =
      yr >= 2018
        ? "VIIRS_NOAA20_CorrectedReflectance_TrueColor"
        : "MODIS_Terra_CorrectedReflectance_TrueColor";

    const buildGibsUrl = (layer, d) =>
      `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${d}/GoogleMapsCompatible_Level9/${z}/${y}/${x}.jpg`;

    let res = await fetch(buildGibsUrl(primaryLayer, reqDate), {
      signal: abortController?.signal,
      mode: "cors",
    }).catch(() => null);

    if (!res || !res.ok) {
      const fallbackDate = `2024-${reqDate.slice(5, 10)}`;
      res = await fetch(buildGibsUrl("MODIS_Terra_CorrectedReflectance_TrueColor", fallbackDate), {
        signal: abortController?.signal,
        mode: "cors",
      });
    }

    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);

    if (!_cloudProcessCanvas) {
      _cloudProcessCanvas = document.createElement("canvas");
      _cloudProcessCanvas.width = 256;
      _cloudProcessCanvas.height = 256;
      _cloudProcessCtx = _cloudProcessCanvas.getContext("2d", { willReadFrequently: true });
    }

    const ctx = _cloudProcessCtx;
    ctx.clearRect(0, 0, 256, 256);
    ctx.drawImage(bmp, 0, 0, 256, 256);
    bmp.close();

    const imgData = ctx.getImageData(0, 0, 256, 256);
    const d = imgData.data;

    // Key out black orbital gaps / polar night AND non-cloud land/ocean so only real white/gray clouds & smoke float over the 3D globe
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const maxC = r > g ? (r > b ? r : b) : g > b ? g : b;
      if (maxC < 68) {
        d[i + 3] = 0;
        continue;
      }
      const minC = r < g ? (r < b ? r : b) : g < b ? g : b;
      const sat = maxC - minC;
      const luma = (r * 77 + g * 150 + b * 29) >> 8;

      // Reject dark ocean, green vegetation, and orange desert sand; retain white/gray cloud decks & smoke plumes
      const isDesertSand = r > b + 34 && g > b + 16 && luma < 205;
      const isOceanOrVegetation = minC < 96 || sat > 66;
      if (isDesertSand || isOceanOrVegetation) {
        d[i + 3] = 0;
        continue;
      }

      const cloudStrength = Math.max(0, luma - 92) - sat * 0.85;
      if (cloudStrength <= 4) {
        d[i + 3] = 0;
      } else {
        const alpha = Math.min(235, Math.round(cloudStrength * 1.9));
        d[i] = Math.min(255, Math.round(r * 0.35 + luma * 0.65 + 16));
        d[i + 1] = Math.min(255, Math.round(g * 0.35 + luma * 0.65 + 16));
        d[i + 2] = Math.min(255, Math.round(b * 0.35 + luma * 0.65 + 20));
        d[i + 3] = alpha;
      }
    }

    ctx.putImageData(imgData, 0, 0);
    const pngBlob = await new Promise((resolve) => _cloudProcessCanvas.toBlob(resolve, "image/png"));
    return { data: await pngBlob.arrayBuffer() };
  });
}

function getGibsCloudDate() {
  const popupDate = document.getElementById("firms-popup-filter-date")?.value;
  if (popupDate && popupDate !== "ALL" && /^\d{4}-\d{2}-\d{2}$/.test(popupDate)) {
    return popupDate;
  }
  const yrRaw = Math.max(2001, Math.min(2026, Number(GFIState.targetYear) || 2026));
  const mmNum = Math.min(12, Math.max(1, Number(GFIState.targetMonth) || 11));
  const mm = String(mmNum).padStart(2, "0");

  let dayNum = yrRaw === 2026 && mmNum === 11 ? 13 : 15;
  if (GFIState.targetDay && GFIState.targetDay !== "ALL") {
    const maxDays = new Date(yrRaw, mmNum, 0).getDate();
    dayNum = Math.min(maxDays, Math.max(1, parseInt(GFIState.targetDay, 10) || 13));
  }
  const dd = String(dayNum).padStart(2, "0");

  // Clamp future dates past 2026-11-14 to 2025 so NASA GIBS WMTS always has valid satellite passes
  const effectiveYr = yrRaw === 2026 && (mmNum > 11 || (mmNum === 11 && dayNum > 14)) ? 2025 : yrRaw;
  return `${effectiveYr}-${mm}-${dd}`;
}

function syncEnvironmentalLayers() {
  registerNasaCloudsProtocol();
  const cloudBtn = document.getElementById("toggle-layer-clouds");
  cloudBtn?.classList.toggle("active", !!GFIState.map.layers.clouds);
  document.getElementById("toggle-layer-topo")?.classList.toggle("active", !!GFIState.map.layers.topo);

  const m = GFIState.map.mainInstance;
  if (!m || !m.getStyle()) return;

  const beforeId = m.getLayer("thermal-heatmap") ? "thermal-heatmap" : undefined;

  if (GFIState.map.layers.topo) {
    if (!m.getSource("esri-topo-src")) {
      m.addSource("esri-topo-src", {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        maxzoom: 12,
      });
    }
    if (!m.getLayer("esri-topo-layer")) {
      m.addLayer({
        id: "esri-topo-layer",
        type: "raster",
        source: "esri-topo-src",
        paint: { "raster-opacity": 0.72, "raster-contrast": 0.42, "raster-fade-duration": 0 },
      }, beforeId);
    }
  } else {
    // Destroy layer & source when turned off so WebGL immediately frees all tile textures in RAM
    if (m.getLayer("esri-topo-layer")) m.removeLayer("esri-topo-layer");
    if (m.getSource("esri-topo-src")) m.removeSource("esri-topo-src");
  }

  if (GFIState.map.layers.clouds) {
    const gibsDate = getGibsCloudDate();
    const cloudSub = cloudBtn?.querySelector("small");
    if (cloudSub) cloudSub.textContent = `GIBS • ${gibsDate}`;
    if (m._activeGibsDate !== gibsDate || !m.getSource("gibs-clouds-src")) {
      if (m.getLayer("gibs-clouds-layer")) m.removeLayer("gibs-clouds-layer");
      if (m.getSource("gibs-clouds-src")) m.removeSource("gibs-clouds-src");
      if (m.getLayer("gibs-smoke-layer")) m.removeLayer("gibs-smoke-layer");
      if (m.getSource("gibs-smoke-src")) m.removeSource("gibs-smoke-src");

      // Live NASA GIBS VIIRS/MODIS True Color Cloud & Smoke extraction layer (keyed transparency, zero black swath bars)
      m.addSource("gibs-clouds-src", {
        type: "raster",
        tiles: [`nasaclouds://${gibsDate}/{z}/{y}/{x}`],
        tileSize: 256,
        maxzoom: 6,
        attribution: `NASA GIBS VIIRS/MODIS Clouds (${gibsDate})`,
      });
      m.addLayer({
        id: "gibs-clouds-layer",
        type: "raster",
        source: "gibs-clouds-src",
        paint: { "raster-opacity": 0.88, "raster-fade-duration": 0 },
      }, beforeId);
      m._activeGibsDate = gibsDate;
    }
  } else {
    const cloudSub = cloudBtn?.querySelector("small");
    if (cloudSub) cloudSub.textContent = "Real-Time NASA GIBS";
    if (m.getLayer("gibs-clouds-layer")) m.removeLayer("gibs-clouds-layer");
    if (m.getSource("gibs-clouds-src")) m.removeSource("gibs-clouds-src");
    if (m.getLayer("gibs-smoke-layer")) m.removeLayer("gibs-smoke-layer");
    if (m.getSource("gibs-smoke-src")) m.removeSource("gibs-smoke-src");
    m._activeGibsDate = null;
  }

  syncNightEarthLayer();
}

function syncNightEarthLayer() {
  const m = GFIState.map.mainInstance;
  if (!m || !m.getStyle()) return;

  const isNightMode = (document.getElementById("map-filter-daynight")?.value || "ALL") === "N";
  const isSat = GFIState.map.basemapMode === "satellite";

  if (isNightMode) {
    if (m.getLayer("base-layer")) {
      try {
        m.setPaintProperty("base-layer", "raster-brightness-max", 0.22);
      } catch (_) {}
    }

    if (!m.getSource("nasa-night-lights-src")) {
      m.addSource("nasa-night-lights-src", {
        type: "raster",
        tiles: [
          "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_CityLights_2012/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpg",
        ],
        tileSize: 256,
        maxzoom: 8,
        attribution: "NASA Earth at Night (VIIRS Black Marble)",
      });
    }

    if (!m.getLayer("nasa-night-lights-layer")) {
      const candidateOrder = ["labels-layer", "dark-labels-layer", "esri-topo-layer", "gibs-clouds-layer", "thermal-heatmap"];
      const beforeId = candidateOrder.find((id) => Boolean(m.getLayer(id)));
      m.addLayer(
        {
          id: "nasa-night-lights-layer",
          type: "raster",
          source: "nasa-night-lights-src",
          paint: {
            "raster-opacity": 0.96,
            "raster-contrast": 0.16,
            "raster-fade-duration": 0,
          },
        },
        beforeId
      );
    }
  } else {
    if (m.getLayer("nasa-night-lights-layer")) m.removeLayer("nasa-night-lights-layer");
    if (m.getSource("nasa-night-lights-src")) m.removeSource("nasa-night-lights-src");

    if (m.getLayer("base-layer")) {
      try {
        m.setPaintProperty("base-layer", "raster-brightness-max", isSat ? 1 : 0.85);
      } catch (_) {}
    }
  }
}

function updateMeasureOverlay() {
  const m = GFIState.map.mainInstance;
  const pts = GFIState.map.measurePoints || [];
  const readout = document.getElementById("measure-distance-readout");
  const features = pts.map(([lat, lon]) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
  }));

  let totalKm = 0;
  if (pts.length >= 2) {
    for (let i = 1; i < pts.length; i++) {
      totalKm += haversineKm(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    }
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: pts.map(([lat, lon]) => [lon, lat]) },
    });
  }

  const src = m?.getSource("measure-src");
  if (src) src.setData({ type: "FeatureCollection", features });

  if (readout) {
    if (pts.length === 0) {
      readout.classList.add("hidden");
      readout.textContent = "";
    } else if (pts.length === 1) {
      readout.classList.remove("hidden");
      readout.textContent = "Click 2nd point on globe to measure km / mi";
    } else {
      readout.classList.remove("hidden");
      const miles = totalKm * 0.621371;
      readout.textContent = `Distance (${pts.length} pts): ${totalKm.toFixed(1)} km (${miles.toFixed(1)} mi)`;
    }
  }
}

async function syncTopSearchWithLocation() {
  const topInput = document.getElementById("top-quick-search-input");
  if (!monitoredUserCoords) return;

  const rawLbl = monitoredUserCoords.resolvedPlace || monitoredUserCoords.label || monitoredUserCoords.sourceLabel || "";
  const isGeneric =
    !rawLbl ||
    /^(your gps location|custom location|custom point|ip location)$/i.test(rawLbl.trim()) ||
    /^-?\d+(?:\.\d+)?°?,\s*-?\d+(?:\.\d+)?°?$/.test(rawLbl.trim());

  const fallbackText = isGeneric
    ? `${Number(monitoredUserCoords.lat).toFixed(3)}°, ${Number(monitoredUserCoords.lon).toFixed(3)}°`
    : rawLbl;

  if (topInput && document.activeElement !== topInput) {
    topInput.value = fallbackText;
  }

  if (isGeneric && navigator.onLine) {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(monitoredUserCoords.lat)}&lon=${encodeURIComponent(monitoredUserCoords.lon)}&zoom=10`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (res.ok) {
        const info = await res.json();
        const a = info?.address || {};
        const city = a.city || a.town || a.village || a.municipality || a.county || "";
        const state = a.state || "";
        const country = a.country || "";
        const resolved = [city, state, country].filter(Boolean).join(", ") || info?.display_name?.split(",").slice(0, 2).join(", ");
        if (resolved) {
          monitoredUserCoords.resolvedPlace = resolved;
          try {
            localStorage.setItem(USER_COORDS_STORAGE_KEY, JSON.stringify(monitoredUserCoords));
          } catch (_) {}
          if (topInput && document.activeElement !== topInput) {
            topInput.value = resolved;
          }
        }
      }
    } catch (_) {}
  }
}

function resolveRegionForCoords(lat, lon) {
  const regs = (GFIState.regions || []).filter((r) => r.region_code && r.region_code !== "ALL" && r.center_lat != null && r.center_lon != null);
  let best = null;
  let bestDist = Infinity;
  regs.forEach((r) => {
    const d = haversineKm(lat, lon, Number(r.center_lat), Number(r.center_lon));
    if (d < bestDist) {
      bestDist = d;
      best = r.region_code;
    }
  });
  return best && bestDist <= 1800 ? best : "ALL";
}

function setCustomMonitorLocation(lat, lon, label = "Custom Location") {
  monitoredUserCoords = { lat: Number(lat), lon: Number(lon), source: "custom", label, sourceLabel: label };
  try {
    localStorage.setItem(USER_COORDS_STORAGE_KEY, JSON.stringify(monitoredUserCoords));
  } catch (_) {}
  syncTopSearchWithLocation();
  updateUserLocationMarker();
  flyToUserLocation(1100);
  runSwathWatchdogCycle(true);
}

function applyMapVisualLayerMode() {
  const m = GFIState.map.mainInstance;
  if (!m) return;

  const metric = GFIState.metricMode || "harmonized_calibrated";

  if (m.getLayer("thermal-heatmap")) {
    m.setLayoutProperty("thermal-heatmap", "visibility", "visible");
    if (metric === "harmonized_frp") {
      m.setPaintProperty("thermal-heatmap", "heatmap-weight", [
        "interpolate", ["linear"], ["coalesce", ["get", "frp"], 10],
        0, 0.08,
        35, 0.45,
        120, 1.0,
      ]);
    } else {
      m.setPaintProperty("thermal-heatmap", "heatmap-weight", [
        "interpolate", ["linear"], ["coalesce", ["get", "frp"], 20],
        0, 0.15,
        40, 0.55,
        150, 1.0,
      ]);
    }
  }
  if (m.getLayer("hotspots-glow")) {
    m.setLayoutProperty("hotspots-glow", "visibility", "visible");
    m.setPaintProperty("hotspots-glow", "circle-color", [
      "match",
      ["get", "instrument"],
      "MODIS", "rgba(56, 189, 248, 0.55)",
      "VIIRS", "rgba(249, 115, 22, 0.55)",
      "rgba(192, 132, 252, 0.55)",
    ]);
  }
  if (m.getLayer("unclustered-hotspots")) {
    let filterExpr = null;
    if (metric === "harmonized_frp") {
      // Scale point color & radius dynamically by radiative intensity (MW)
      m.setPaintProperty("unclustered-hotspots", "circle-color", [
        "interpolate", ["linear"], ["coalesce", ["get", "frp"], 10],
        0, "#f59e0b",
        35, "#f97316",
        85, "#ef4444",
        160, "#fef08a",
      ]);
      m.setPaintProperty("unclustered-hotspots", "circle-radius", [
        "interpolate", ["linear"], ["coalesce", ["get", "frp"], 10],
        0, 2.2,
        40, 4.4,
        140, 7.6,
      ]);
      m.setPaintProperty("unclustered-hotspots", "circle-stroke-color", "rgba(255, 255, 255, 0.85)");
    } else if (metric === "colocated_events") {
      // Confirmed co-located / multi-pixel physical thermal events
      filterExpr = [
        "any",
        ["==", ["get", "event_sensor_composition"], "DUAL_SENSOR_COINCIDENT"],
        [">", ["coalesce", ["get", "event_pixel_count"], 1], 1],
      ];
      m.setPaintProperty("unclustered-hotspots", "circle-color", "#10b981");
      m.setPaintProperty("unclustered-hotspots", "circle-radius", [
        "interpolate", ["linear"], ["zoom"],
        2, 2.0,
        6, 4.2,
        10, 7.2,
      ]);
      m.setPaintProperty("unclustered-hotspots", "circle-stroke-color", "#ecfdf5");
    } else if (metric === "raw_concatenated") {
      // Visualize raw MODIS (1km Cyan) vs VIIRS (375m Orange) oversampling overlap
      m.setPaintProperty("unclustered-hotspots", "circle-color", [
        "match", ["get", "instrument"],
        "MODIS", "#38bdf8",
        "VIIRS", "#fb923c",
        "#e2e8f0",
      ]);
      m.setPaintProperty("unclustered-hotspots", "circle-radius", [
        "interpolate", ["linear"], ["zoom"],
        2, 1.6,
        5, ["match", ["get", "instrument"], "MODIS", 3.4, 1.9],
        9, ["match", ["get", "instrument"], "MODIS", 6.2, 3.3],
      ]);
      m.setPaintProperty("unclustered-hotspots", "circle-stroke-color", "rgba(255, 255, 255, 0.78)");
    } else {
      // Harmonized Calibrated Fires: crisp NASA red/orange pixels over infrared thermal plume
      m.setPaintProperty("unclustered-hotspots", "circle-color", [
        "match", ["get", "instrument"],
        "MODIS", "#ff5a1f",
        "VIIRS", "#ef4444",
        "#f97316",
      ]);
      m.setPaintProperty("unclustered-hotspots", "circle-radius", [
        "interpolate", ["linear"], ["zoom"],
        2, 1.4,
        5, ["match", ["get", "instrument"], "MODIS", 2.8, 1.8],
        8, ["match", ["get", "instrument"], "MODIS", 5.2, 3.1],
        11, ["match", ["get", "instrument"], "MODIS", 9.0, 5.0],
      ]);
      m.setPaintProperty("unclustered-hotspots", "circle-stroke-color", "rgba(255, 224, 178, 0.75)");
    }

    m.setPaintProperty("unclustered-hotspots", "circle-opacity", 0.94);
    m.setPaintProperty("unclustered-hotspots", "circle-stroke-width", [
      "interpolate", ["linear"], ["zoom"],
      4, 0.0,
      8, 0.7,
    ]);
    m.setFilter("unclustered-hotspots", filterExpr);
    if (m.getLayer("hotspots-glow")) {
      m.setFilter("hotspots-glow", filterExpr);
    }
  }
}

function initMapLibreMaps() {
  if (typeof maplibregl === "undefined") {
    console.warn("MapLibre GL no está disponible.");
    return;
  }

  const ovEl = document.getElementById("map-overview-gl");
  if (ovEl) {
    const ovMap = new maplibregl.Map({
      container: ovEl,
      style: buildMapLibreStyle("satellite"),
      center: [GFIState.map.centerLon, GFIState.map.centerLat],
      zoom: 2.6,
      pitch: 18,
      canvasContextAttributes: { antialias: true },
    });
    ovMap.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
    ovMap.on("style.load", () => {
      try { ovMap.setProjection({ type: "globe" }); } catch (_) {}
      addHotspotSourcesAndLayers(ovMap, true);
      updateMapLibreData();
      updateUserLocationMarker();
    });
    GFIState.map.overviewInstance = ovMap;
  }

  const mainEl = document.getElementById("map-main-gl");
  if (mainEl) {
    registerNasaCloudsProtocol();
    const startCenter = monitoredUserCoords
      ? [monitoredUserCoords.lon, monitoredUserCoords.lat]
      : [GFIState.map.centerLon, GFIState.map.centerLat];
    const startZoom = monitoredUserCoords ? 2.4 : 4.5;

    const mainMap = new maplibregl.Map({
      container: mainEl,
      style: buildMapLibreStyle("satellite"),
      center: startCenter,
      zoom: startZoom,
      minZoom: 1.75,
      maxZoom: 16,
      pitch: 10,
      attributionControl: false,
      crossSourceCollisions: false,
      maxTileCacheSize: 240,
      maxTileCacheZoomLevels: 5,
      refreshExpiredTiles: false,
      canvasContextAttributes: { antialias: false, preserveDrawingBuffer: true },
    });
    mainMap.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    mainMap.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: "metric" }), "bottom-right");
    mainMap.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: "imperial" }), "bottom-right");
    mainMap.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    // Ensure attribution pill always starts collapsed until explicitly clicked
    setTimeout(() => {
      document
        .querySelectorAll("#main-globe-map .maplibregl-ctrl-attrib.maplibregl-compact-show")
        .forEach((el) => el.classList.remove("maplibregl-compact-show"));
    }, 80);

    mainMap.on("style.load", () => {
      try {
        mainMap.setProjection({ type: GFIState.map.projectionMode });
      } catch (_) {}
      addHotspotSourcesAndLayers(mainMap, false);
      syncEnvironmentalLayers();
      updateMapLibreData(true);
      updateSelectionOverlay();
      updateMeasureOverlay();
      updateUserLocationMarker();
    });

    if (monitoredUserCoords) {
      mainMap.once("load", () => {
        flyToUserLocation(1150);
      });
    }

    // Click on cluster -> zoom in
    mainMap.on("click", "clusters-circle", (e) => {
      const features = mainMap.queryRenderedFeatures(e.point, { layers: ["clusters-circle"] });
      if (!features.length) return;
      const clusterId = features[0].properties.cluster_id;
      mainMap.getSource("hotspots-src").getClusterExpansionZoom(clusterId, (err, zoom) => {
        if (err) return;
        mainMap.easeTo({ center: features[0].geometry.coordinates, zoom });
      });
    });

    // NASA FIRMS-style Click-Radius Zone Selector (purple circle with yellow border)
    const haversineKm = (lat1, lon1, lat2, lon2) => {
      const toRad = (deg) => (deg * Math.PI) / 180;
      const R = 6371.0;
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };

    const buildCircleGeoJson = (centerLat, centerLon, radiusKm, steps = 64) => {
      const coords = [];
      const earthKm = 6371.0;
      const latRad = (centerLat * Math.PI) / 180;
      const dLat = (radiusKm / earthKm) * (180 / Math.PI);
      const dLon = dLat / Math.max(0.15, Math.cos(latRad));
      for (let i = 0; i <= steps; i++) {
        const theta = (i / steps) * 2 * Math.PI;
        coords.push([centerLon + dLon * Math.cos(theta), centerLat + dLat * Math.sin(theta)]);
      }
      return {
        type: "FeatureCollection",
        features: [{ type: "Feature", geometry: { type: "Polygon", coordinates: [coords] } }],
      };
    };

    const inspectZoneAtCoords = async (lat, lon, customRadiusKm = null) => {
      const zoom = mainMap.getZoom();
      const radiusKm =
        customRadiusKm ||
        (zoom <= 2.5 ? 180 : zoom <= 4 ? 75 : zoom <= 6 ? 28 : zoom <= 8 ? 10 : 3.5);

      const clickSrc = mainMap.getSource("click-radius-src");
      if (clickSrc) {
        clickSrc.setData(buildCircleGeoJson(lat, lon, radiusKm));
      }

      const allHotspots = GFIState.hotspotsData?.hotspots || [];
      const inside = allHotspots
        .map((h) => ({ h, dist: haversineKm(lat, lon, h.latitude, h.longitude) }))
        .filter((x) => x.dist <= radiusKm)
        .sort((a, b) => a.dist - b.dist);

      if (inside.length > 0) {
        const closest = inside[0].h;
        const zoneRecords = inside.slice(0, 250).map((x) => x.h);
        GFIState.selectedHotspot = closest;
        await inspectHotspotDetails(closest, zoneRecords, radiusKm);
      } else {
        const popupEl = document.getElementById("firms-pixel-popup");
        popupEl?.classList.remove("active", "popup-collapsed");
        const box = document.getElementById("hotspot-inspector-content");
        if (box) {
          box.innerHTML = `<div class="sci-callout">No thermal detections within <strong>${radiusKm} km</strong> around (${lat.toFixed(3)}°, ${lon.toFixed(3)}°). Click over any active fire cluster.</div>`;
        }
      }
    };
    GFIState.map.inspectZoneAtCoords = inspectZoneAtCoords;

    mainMap.on("click", async (e) => {
      if (GFIState.map.tool === "pick_loc") {
        setCustomMonitorLocation(e.lngLat.lat, e.lngLat.lng, `${e.lngLat.lat.toFixed(2)}°, ${e.lngLat.lng.toFixed(2)}°`);
        GFIState.map.setTool?.("pan");
        return;
      }
      if (GFIState.map.tool === "measure") {
        GFIState.map.measurePoints.push([Number(e.lngLat.lat.toFixed(4)), Number(e.lngLat.lng.toFixed(4))]);
        updateMeasureOverlay();
        return;
      }
      if (GFIState.map.tool !== "pan") return;
      await inspectZoneAtCoords(e.lngLat.lat, e.lngLat.lng);
    });

    mainMap.on("mouseenter", "unclustered-hotspots", () => {
      if (GFIState.map.tool === "pan") mainMap.getCanvas().style.cursor = "pointer";
    });
    mainMap.on("mouseleave", "unclustered-hotspots", () => {
      if (GFIState.map.tool === "pan") mainMap.getCanvas().style.cursor = "";
    });

    let _lastHudCoordsTs = 0;
    mainMap.on("mousemove", (e) => {
      const now = performance.now();
      if (now - _lastHudCoordsTs < 150 || mainMap.isMoving()) return;
      _lastHudCoordsTs = now;
      const footer = document.getElementById("main-map-coords-footer");
      if (footer && e.lngLat) {
        const projLbl = GFIState.map.projectionMode === "globe" ? "3D Globe" : "2D Map";
        footer.textContent = `Cursor: Lat ${e.lngLat.lat.toFixed(4)}°, Lon ${e.lngLat.lng.toFixed(4)}° | Zoom: ${mainMap.getZoom().toFixed(1)}x | ${projLbl} | Tool: ${GFIState.map.tool.toUpperCase()}`;
      }
      if (GFIState.map.tool === "rect" && GFIState.map.isDrawingRect) {
        GFIState.map.rectCurrentLngLat = [e.lngLat.lng, e.lngLat.lat];
        updateSelectionOverlay();
      }
    });

    mainMap.on("mousedown", (e) => {
      if (GFIState.map.tool === "rect") {
        GFIState.map.isDrawingRect = true;
        GFIState.map.rectStartLngLat = [e.lngLat.lng, e.lngLat.lat];
        GFIState.map.rectCurrentLngLat = [e.lngLat.lng, e.lngLat.lat];
      } else if (GFIState.map.tool === "poly") {
        GFIState.map.polygonPoints.push([Number(e.lngLat.lat.toFixed(4)), Number(e.lngLat.lng.toFixed(4))]);
        updateSelectionOverlay();
        if (GFIState.map.polygonPoints.length >= 3) {
          loadSpatialHotspots();
        }
      }
    });

    mainMap.on("mouseup", async () => {
      if (GFIState.map.tool === "rect" && GFIState.map.isDrawingRect) {
        GFIState.map.isDrawingRect = false;
        const [lon1, lat1] = GFIState.map.rectStartLngLat || [0, 0];
        const [lon2, lat2] = GFIState.map.rectCurrentLngLat || [0, 0];
        if (Math.abs(lat1 - lat2) > 0.05 && Math.abs(lon1 - lon2) > 0.05) {
          GFIState.map.customBBox = {
            minLat: Number(Math.min(lat1, lat2).toFixed(4)),
            maxLat: Number(Math.max(lat1, lat2).toFixed(4)),
            minLon: Number(Math.min(lon1, lon2).toFixed(4)),
            maxLon: Number(Math.max(lon1, lon2).toFixed(4)),
          };
          document.getElementById("bbox-min-lat").value = GFIState.map.customBBox.minLat;
          document.getElementById("bbox-max-lat").value = GFIState.map.customBBox.maxLat;
          document.getElementById("bbox-min-lon").value = GFIState.map.customBBox.minLon;
          document.getElementById("bbox-max-lon").value = GFIState.map.customBBox.maxLon;
          GFIState.map.rectStartLngLat = null;
          GFIState.map.rectCurrentLngLat = null;
          updateSelectionOverlay();
          await loadSpatialHotspots();
        }
      }
    });

    GFIState.map.mainInstance = mainMap;
  }
}

function hotspotsToGeoJSON(hotspots) {
  const list = hotspots || [];
  const features = new Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const h = list[i];
    features[i] = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [h.longitude, h.latitude] },
      properties: {
        id: h.id,
        instrument: h.instrument,
        daynight: h.daynight || "D",
        frp: h.frp,
        event_sensor_composition: h.event_sensor_composition || "SINGLE",
        event_pixel_count: h.event_pixel_count || 1,
      },
    };
  }
  return {
    type: "FeatureCollection",
    features,
  };
}

function updateUserLocationMarker() {
  const fc = monitoredUserCoords
    ? {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: {
              type: "Point",
              coordinates: [monitoredUserCoords.lon, monitoredUserCoords.lat],
            },
            properties: { label: monitoredUserCoords.sourceLabel || "Your Location" },
          },
        ],
      }
    : { type: "FeatureCollection", features: [] };

  [GFIState.map.overviewInstance, GFIState.map.mainInstance].forEach((m) => {
    if (!m) return;
    const src = m.getSource("user-location-src");
    if (src) src.setData(fc);
  });
}

function flyToUserLocation(durationMs = 1150) {
  if (!monitoredUserCoords) return;
  updateUserLocationMarker();
  const center = [monitoredUserCoords.lon, monitoredUserCoords.lat];
  GFIState.map.mainInstance?.flyTo({
    center,
    zoom: 5.8,
    pitch: 28,
    duration: durationMs,
    essential: true,
  });
  GFIState.map.overviewInstance?.flyTo({
    center,
    zoom: 4.0,
    pitch: 20,
    duration: durationMs,
  });
}

let _lastHotspotsMapRef = null;
function updateMapLibreData(force = false) {
  const hsData = GFIState.hotspotsData;
  if (!hsData) return;
  const mainSrc = GFIState.map.mainInstance?.getSource("hotspots-src");
  const ovSrc = GFIState.map.overviewInstance?.getSource("hotspots-src");
  if (!mainSrc && !ovSrc) return;
  if (!force && _lastHotspotsMapRef === hsData && mainSrc) {
    applyMapVisualLayerMode();
    return;
  }
  _lastHotspotsMapRef = hsData;
  const gj = hotspotsToGeoJSON(hsData.hotspots || []);

  if (ovSrc) ovSrc.setData(gj);
  if (mainSrc) mainSrc.setData(gj);
  applyMapVisualLayerMode();

  const ovFooter = document.getElementById("overview-map-footer");
  if (ovFooter && hsData.summary) {
    ovFooter.textContent = `Globo 3D • ${formatInt(hsData.summary.returned_records)} hotspots (MODIS: ${formatInt(hsData.summary.modis_detections)} | VIIRS: ${formatInt(hsData.summary.viirs_detections)})`;
  }
}

function updateSelectionOverlay() {
  const m = GFIState.map.mainInstance;
  if (!m) return;
  const src = m.getSource("selection-src");
  if (!src) return;

  const features = [];
  if (GFIState.map.rectStartLngLat && GFIState.map.rectCurrentLngLat) {
    const [x1, y1] = GFIState.map.rectStartLngLat;
    const [x2, y2] = GFIState.map.rectCurrentLngLat;
    features.push({
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [[[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]]],
      },
    });
  } else if (GFIState.map.customBBox) {
    const b = GFIState.map.customBBox;
    features.push({
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [[[b.minLon, b.minLat], [b.maxLon, b.minLat], [b.maxLon, b.maxLat], [b.minLon, b.maxLat], [b.minLon, b.minLat]]],
      },
    });
  } else if (GFIState.map.polygonPoints.length >= 2) {
    const ring = GFIState.map.polygonPoints.map(([lat, lon]) => [lon, lat]);
    if (ring.length >= 3) ring.push(ring[0]);
    features.push({
      type: "Feature",
      geometry: {
        type: ring.length >= 4 ? "Polygon" : "LineString",
        coordinates: ring.length >= 4 ? [ring] : ring,
      },
    });
  }
  src.setData({ type: "FeatureCollection", features });
}

function bindMapControls() {
  const setTool = (toolName) => {
    GFIState.map.tool = toolName;
    ["pan", "rect", "poly", "measure"].forEach((t) => {
      document.getElementById(`map-tool-${t}`)?.classList.toggle("active", t === toolName);
    });
    const m = GFIState.map.mainInstance;
    if (m) {
      if (toolName === "pan" || toolName === "measure" || toolName === "pick_loc") {
        m.dragPan.enable();
        m.getCanvas().style.cursor = toolName === "pan" ? "" : "crosshair";
      } else {
        m.dragPan.disable();
        m.getCanvas().style.cursor = "crosshair";
      }
    }
  };
  GFIState.map.setTool = setTool;
  setTool("pan");

  document.getElementById("map-tool-pan")?.addEventListener("click", () => setTool("pan"));
  document.getElementById("map-tool-rect")?.addEventListener("click", () => {
    GFIState.map.polygonPoints = [];
    setTool("rect");
  });
  document.getElementById("map-tool-poly")?.addEventListener("click", () => {
    GFIState.map.customBBox = null;
    GFIState.map.polygonPoints = [];
    setTool("poly");
    updateSelectionOverlay();
  });
  document.getElementById("map-tool-measure")?.addEventListener("click", () => {
    if (GFIState.map.tool === "measure") {
      setTool("pan");
    } else {
      GFIState.map.measurePoints = [];
      updateMeasureOverlay();
      setTool("measure");
    }
  });
  document.getElementById("map-tool-reset")?.addEventListener("click", async () => {
    GFIState.map.customBBox = null;
    GFIState.map.polygonPoints = [];
    GFIState.map.measurePoints = [];
    document.getElementById("firms-pixel-popup")?.classList.remove("active", "popup-collapsed");
    updateSelectionOverlay();
    updateMeasureOverlay();
    syncMapCenterToRegion(GFIState.regionCode);
    setTool("pan");
    syncNightEarthLayer();
    syncBboxStatusBadge();
    await loadSpatialHotspots();
  });

  initCustomFilterPickers();
  initBboxCoordsModal();
  initTimelineCalendarModal();

  // NASA FIRMS Quick Time Window Bar + Synced Dropdown
  document.querySelectorAll("#firms-window-bar .seg-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const scope = btn.dataset.scope;
      if (!scope) return;
      document.querySelectorAll("#firms-window-bar .seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
      const scopeEl = document.getElementById("map-time-scope");
      if (scopeEl) scopeEl.value = scope;
      await loadSpatialHotspots();
    });
  });

  // Environmental Overlays (NASA GIBS Clouds/Smoke & Esri Topographic Relief)
  document.getElementById("toggle-layer-clouds")?.addEventListener("click", () => {
    GFIState.map.layers.clouds = !GFIState.map.layers.clouds;
    syncEnvironmentalLayers();
  });
  document.getElementById("toggle-layer-topo")?.addEventListener("click", () => {
    GFIState.map.layers.topo = !GFIState.map.layers.topo;
    syncEnvironmentalLayers();
  });

  // FIRMS Quick Search & Custom Location Modal
  const OFFLINE_GAZETTEER = [
    { name: "Chihuahua, Mexico", lat: 28.633, lon: -106.069 },
    { name: "Monterrey, Mexico", lat: 25.6866, lon: -100.3161 },
    { name: "Mexico City, Mexico", lat: 19.4326, lon: -99.1332 },
    { name: "Guadalajara, Mexico", lat: 20.6597, lon: -103.3496 },
    { name: "Los Angeles, California", lat: 34.0522, lon: -118.2437 },
    { name: "San Francisco, California", lat: 37.7749, lon: -122.4194 },
    { name: "Phoenix, Arizona", lat: 33.4484, lon: -112.074 },
    { name: "Denver, Colorado", lat: 39.7392, lon: -104.9903 },
    { name: "Miami, Florida", lat: 25.7617, lon: -80.1918 },
    { name: "New York, USA", lat: 40.7128, lon: -74.006 },
    { name: "Manaus / Amazon Basin, Brazil", lat: -3.119, lon: -60.0217 },
    { name: "Sao Paulo, Brazil", lat: -23.5505, lon: -46.6333 },
    { name: "Madrid, Spain", lat: 40.4168, lon: -3.7038 },
    { name: "Athens, Greece", lat: 37.9838, lon: 23.7275 },
    { name: "Cairo, Egypt", lat: 30.0444, lon: 31.2357 },
    { name: "Nairobi, Kenya", lat: -1.2921, lon: 36.8219 },
    { name: "Cape Town, South Africa", lat: -33.9249, lon: 18.4241 },
    { name: "Sydney, Australia", lat: -33.8688, lon: 151.2093 },
    { name: "Tokyo, Japan", lat: 35.6762, lon: 139.6503 },
    { name: "Yakutsk / Siberia", lat: 62.0397, lon: 129.7422 },
  ];

  const searchModal = document.getElementById("location-search-modal");
  const searchInput = document.getElementById("input-location-search");
  const topQuickInput = document.getElementById("top-quick-search-input");
  const searchResults = document.getElementById("location-search-results");
  const SAVED_LOCS_KEY = "choki_saved_locations_v1";

  const loadSavedLocationsList = () => {
    try {
      const raw = localStorage.getItem(SAVED_LOCS_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length > 0) return arr;
      }
    } catch (_) {}
    return [
      { name: "Chihuahua, Mexico (Sierra Madre)", lat: 28.633, lon: -106.069 },
      { name: "Los Angeles / Southern California", lat: 34.0522, lon: -118.2437 },
      { name: "Manaus / Central Amazon Basin", lat: -3.119, lon: -60.0217 },
      { name: "Mediterranean Basin (Athens)", lat: 37.9838, lon: 23.7275 },
    ];
  };

  const saveLocationsList = (arr) => {
    try {
      localStorage.setItem(SAVED_LOCS_KEY, JSON.stringify(arr.slice(0, 20)));
    } catch (_) {}
  };

  const updateCurrentLocationReadout = () => {
    const readout = document.getElementById("firms-loc-current-readout");
    if (!readout) return;
    if (monitoredUserCoords) {
      readout.textContent = `${monitoredUserCoords.sourceLabel || "Custom Point"} (${monitoredUserCoords.lat.toFixed(4)}°, ${monitoredUserCoords.lon.toFixed(4)}°)`;
    } else {
      readout.textContent = "Global View (Click Detect GPS or Pick on Globe)";
    }
  };

  const renderSavedLocations = () => {
    const container = document.getElementById("firms-saved-locations-list");
    if (!container) return;
    const list = loadSavedLocationsList();
    container.innerHTML = "";
    list.forEach((loc, idx) => {
      const row = document.createElement("div");
      row.className = "firms-saved-item";
      const infoBtn = document.createElement("button");
      infoBtn.type = "button";
      infoBtn.style.cssText = "background:none;border:none;color:inherit;text-align:left;cursor:pointer;flex:1;padding:0;";
      infoBtn.innerHTML = `<div>${loc.name}</div><div class="firms-saved-coords">${Number(loc.lat).toFixed(3)}°, ${Number(loc.lon).toFixed(3)}°</div>`;
      infoBtn.addEventListener("click", () => {
        if (searchModal) searchModal.style.display = "none";
        setCustomMonitorLocation(Number(loc.lat), Number(loc.lon), loc.name);
        updateCurrentLocationReadout();
      });
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "firms-saved-del";
      delBtn.textContent = "✕";
      delBtn.title = "Remove saved location";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const updated = loadSavedLocationsList().filter((_, i) => i !== idx);
        saveLocationsList(updated);
        renderSavedLocations();
      });
      row.appendChild(infoBtn);
      row.appendChild(delBtn);
      container.appendChild(row);
    });
  };

  const switchLocationToolTab = (tabId) => {
    document.querySelectorAll(".firms-loc-tab[data-loctab]").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-loctab") === tabId);
    });
    const paneCur = document.getElementById("firms-loc-pane-current");
    const paneFind = document.getElementById("firms-loc-pane-find");
    const paneSaved = document.getElementById("firms-loc-pane-saved");
    if (paneCur) paneCur.style.display = tabId === "current" ? "block" : "none";
    if (paneFind) paneFind.style.display = tabId === "find" ? "block" : "none";
    if (paneSaved) paneSaved.style.display = tabId === "saved" ? "block" : "none";
    if (tabId === "current") updateCurrentLocationReadout();
    if (tabId === "saved") renderSavedLocations();
  };

  document.querySelectorAll(".firms-loc-tab[data-loctab]").forEach((btn) => {
    btn.addEventListener("click", () => switchLocationToolTab(btn.getAttribute("data-loctab")));
  });

  const renderSearchResults = (items) => {
    if (!searchResults) return;
    searchResults.innerHTML = "";
    if (!items.length) {
      searchResults.innerHTML = `<div class="search-hint-text" style="padding:8px;">No matching places found. Try coordinates like <code>28.63, -106.08</code> or pick directly on the globe.</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    items.forEach((loc) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "search-result-item";
      const nameSpan = document.createElement("span");
      nameSpan.textContent = loc.name;
      const coordSpan = document.createElement("span");
      coordSpan.className = "search-result-coords";
      coordSpan.textContent = `${loc.lat.toFixed(3)}°, ${loc.lon.toFixed(3)}°`;
      btn.appendChild(nameSpan);
      btn.appendChild(coordSpan);
      btn.addEventListener("click", () => {
        const multiChk = document.getElementById("chk-multi-location");
        if (multiChk && multiChk.checked) {
          const cur = loadSavedLocationsList();
          cur.unshift({ name: loc.name, lat: loc.lat, lon: loc.lon });
          saveLocationsList(cur);
        } else if (searchModal) {
          searchModal.style.display = "none";
        }
        if (topQuickInput) topQuickInput.value = loc.name;
        setCustomMonitorLocation(loc.lat, loc.lon, loc.name);
        updateCurrentLocationReadout();
      });
      frag.appendChild(btn);
    });
    searchResults.appendChild(frag);
  };

  const topQuickDropdown = document.getElementById("top-quick-search-dropdown");

  const queryLocationCandidates = async (rawQ) => {
    const q = (rawQ || "").trim();
    if (!q) return OFFLINE_GAZETTEER.slice(0, 6);

    const coordMatch = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (coordMatch) {
      const lat = parseFloat(coordMatch[1]);
      const lon = parseFloat(coordMatch[2]);
      if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
        return [{ name: `Coordinates (${lat.toFixed(4)}°, ${lon.toFixed(4)}°)`, lat, lon }];
      }
    }

    const qLow = q.toLowerCase();
    const savedHits = loadSavedLocationsList()
      .filter((s) => String(s.name || "").toLowerCase().includes(qLow))
      .map((s) => ({ name: s.name, lat: Number(s.lat), lon: Number(s.lon) }));
    const localHits = OFFLINE_GAZETTEER.filter((g) => g.name.toLowerCase().includes(qLow));
    const combined = [...savedHits, ...localHits].slice(0, 6);

    if (navigator.onLine && q.length >= 2) {
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`, {
          headers: { Accept: "application/json" },
        });
        if (res.ok) {
          const rows = await res.json();
          if (Array.isArray(rows) && rows.length > 0) {
            return rows.map((r) => ({
              name: r.display_name.split(",").slice(0, 3).join(", "),
              lat: parseFloat(r.lat),
              lon: parseFloat(r.lon),
            }));
          }
        }
      } catch (_) {}
    }
    return combined;
  };

  const renderTopQuickDropdown = (items) => {
    if (!topQuickDropdown) return;
    topQuickDropdown.innerHTML = "";
    if (!items.length) {
      topQuickDropdown.innerHTML = `<div class="search-hint-text" style="padding:8px 10px;">No matching places found. Try coordinates like <code>28.63, -106.08</code>.</div>`;
      topQuickDropdown.style.display = "flex";
      return;
    }
    const frag = document.createDocumentFragment();
    items.forEach((loc) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "search-result-item";
      const nameSpan = document.createElement("span");
      nameSpan.textContent = loc.name;
      const coordSpan = document.createElement("span");
      coordSpan.className = "search-result-coords";
      coordSpan.textContent = `${loc.lat.toFixed(3)}°, ${loc.lon.toFixed(3)}°`;
      btn.appendChild(nameSpan);
      btn.appendChild(coordSpan);
      btn.addEventListener("click", () => {
        if (topQuickInput) topQuickInput.value = loc.name;
        topQuickDropdown.style.display = "none";
        setCustomMonitorLocation(loc.lat, loc.lon, loc.name);
        updateCurrentLocationReadout();
      });
      frag.appendChild(btn);
    });
    topQuickDropdown.appendChild(frag);
    topQuickDropdown.style.display = "flex";
  };

  const runLocationSearch = async (overrideQuery = null) => {
    const q = (overrideQuery !== null ? overrideQuery : searchInput?.value || "").trim();
    if (!q) {
      renderSearchResults(OFFLINE_GAZETTEER.slice(0, 6));
      return;
    }
    const qLow = q.toLowerCase();
    renderSearchResults(OFFLINE_GAZETTEER.filter((g) => g.name.toLowerCase().includes(qLow)));
    const items = await queryLocationCandidates(q);
    renderSearchResults(items);
  };

  const openLocationPopover = (initialQuery = "") => {
    if (!searchModal) return;
    if (topQuickDropdown) topQuickDropdown.style.display = "none";
    searchModal.style.display = "block";
    switchLocationToolTab("find");
    if (initialQuery && searchInput) {
      searchInput.value = initialQuery;
      runLocationSearch(initialQuery);
    } else {
      renderSearchResults(OFFLINE_GAZETTEER.slice(0, 6));
    }
    setTimeout(() => searchInput?.focus(), 40);
  };

  document.getElementById("btn-open-search")?.addEventListener("click", () => {
    const qTop = (topQuickInput?.value || "").trim();
    if (searchModal?.style.display === "block" && !qTop) {
      searchModal.style.display = "none";
      return;
    }
    openLocationPopover(qTop);
  });

  let _topSearchTimer = null;
  let _lastTopMatches = [];
  topQuickInput?.addEventListener("input", () => {
    const q = (topQuickInput.value || "").trim();
    clearTimeout(_topSearchTimer);
    if (!q) {
      if (topQuickDropdown) topQuickDropdown.style.display = "none";
      _lastTopMatches = [];
      return;
    }
    _topSearchTimer = setTimeout(async () => {
      const items = await queryLocationCandidates(q);
      _lastTopMatches = items;
      if ((topQuickInput.value || "").trim() === q) {
        renderTopQuickDropdown(items);
      }
    }, 220);
  });

  topQuickInput?.addEventListener("focus", () => {
    topQuickInput.select();
  });

  topQuickInput?.addEventListener("blur", () => {
    setTimeout(() => {
      if (!topQuickInput.value.trim() && monitoredUserCoords) {
        syncTopSearchWithLocation();
      }
    }, 180);
  });

  topQuickInput?.addEventListener("keydown", async (e) => {
    if (e.key === "Escape" && topQuickDropdown) {
      topQuickDropdown.style.display = "none";
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const q = topQuickInput.value.trim();
      if (!q) {
        openLocationPopover("");
        return;
      }
      const items = _lastTopMatches.length ? _lastTopMatches : await queryLocationCandidates(q);
      if (items.length > 0) {
        const first = items[0];
        topQuickInput.value = first.name;
        if (topQuickDropdown) topQuickDropdown.style.display = "none";
        setCustomMonitorLocation(first.lat, first.lon, first.name);
        updateCurrentLocationReadout();
      } else {
        openLocationPopover(q);
      }
    }
  });

  document.addEventListener("click", (e) => {
    if (topQuickDropdown && !e.target.closest(".top-quick-search-wrap")) {
      topQuickDropdown.style.display = "none";
    }
    if (!e.target.closest(".inline-loc-search-wrap")) {
      document.querySelectorAll(".inline-loc-dropdown").forEach((d) => {
        d.style.display = "none";
      });
    }
  });

  // Shared inline location search for Calendar & Regional Comparator
  const bindInlineLocationSearch = (inputId, dropdownId, onSelect) => {
    const inp = document.getElementById(inputId);
    const dd = document.getElementById(dropdownId);
    if (!inp || !dd) return;

    const getRegionCandidates = (qLow) => {
      const regList = [
        { name: "Global (All Regions)", regionCode: "ALL", lat: 15.0, lon: -30.0 },
        ...(GFIState.regions || [])
          .filter((r) => r.region_code && r.region_code !== "ALL")
          .map((r) => ({ name: r.name, regionCode: r.region_code, lat: Number(r.center_lat), lon: Number(r.center_lon) })),
      ];
      return qLow ? regList.filter((r) => r.name.toLowerCase().includes(qLow) || r.regionCode.toLowerCase().includes(qLow)) : regList;
    };

    const renderList = (items) => {
      dd.innerHTML = "";
      if (!items.length) {
        dd.style.display = "none";
        return;
      }
      items.slice(0, 8).forEach((item) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "search-result-item";
        const codeTag = item.regionCode || resolveRegionForCoords(item.lat, item.lon);
        btn.innerHTML = `<span>${escapeHtml(item.name)}</span><span class="search-result-coords">${escapeHtml(codeTag)}</span>`;
        btn.addEventListener("click", () => {
          inp.value = item.name;
          dd.style.display = "none";
          onSelect({ ...item, resolvedRegion: codeTag });
        });
        dd.appendChild(btn);
      });
      dd.style.display = "flex";
    };

    let timer = null;
    inp.addEventListener("focus", () => {
      const qLow = (inp.value || "").trim().toLowerCase();
      renderList(getRegionCandidates(qLow));
    });
    inp.addEventListener("input", () => {
      clearTimeout(timer);
      const q = (inp.value || "").trim();
      const qLow = q.toLowerCase();
      const regHits = getRegionCandidates(qLow);
      renderList(regHits);
      if (q.length >= 2) {
        timer = setTimeout(async () => {
          const geoHits = await queryLocationCandidates(q);
          const merged = [...regHits, ...geoHits.filter((g) => !regHits.some((r) => r.name === g.name))];
          if ((inp.value || "").trim() === q) renderList(merged);
        }, 220);
      }
    });
  };

  const loadOverviewForRegion = async (regionCode) => {
    const qs = new URLSearchParams({
      region_code: regionCode || "ALL",
      metric_mode: GFIState.metricMode,
      target_year: String(GFIState.targetYear),
      target_month: String(GFIState.targetMonth),
    });
    try {
      const res = await apiFetch(`/api/overview?${qs.toString()}`);
      if (res.ok) {
        GFIState.overviewData = await res.json();
        renderAllOverviewWidgets();
      }
    } catch (_) {}
  };

  bindInlineLocationSearch("cal-location-search", "cal-location-dropdown", async (pick) => {
    await loadOverviewForRegion(pick.resolvedRegion);
  });

  bindInlineLocationSearch("analysis-location-search", "analysis-location-dropdown", async (pick) => {
    await loadOverviewForRegion(pick.resolvedRegion);
  });

  bindInlineLocationSearch("comp-search-a", "comp-dropdown-a", (pick) => {
    GFIState.compRegionA = pick.resolvedRegion;
    const selA = document.getElementById("comp-region-a");
    if (selA) selA.value = pick.resolvedRegion;
    loadAndRenderRegionalComparison();
  });

  bindInlineLocationSearch("comp-search-b", "comp-dropdown-b", (pick) => {
    GFIState.compRegionB = pick.resolvedRegion;
    const selB = document.getElementById("comp-region-b");
    if (selB) selB.value = pick.resolvedRegion;
    loadAndRenderRegionalComparison();
  });

  // Harmonized Database Export Modal
  const exportModal = document.getElementById("harmonized-export-modal");
  if (exportModal) {
    const expState = {
      dataset: "events",
      scope: "full_year",
      format: "csv",
      regionCode: "ALL",
      regionLabel: "Global (All Regions)",
      bbox: null,
    };

    const yearSel = document.getElementById("export-year-select");
    const monthSel = document.getElementById("export-month-select");
    const singleDateEl = document.getElementById("export-single-date");
    const startDateEl = document.getElementById("export-start-date");
    const endDateEl = document.getElementById("export-end-date");
    const locSearchEl = document.getElementById("export-location-search");
    const regionBadgeEl = document.getElementById("export-region-badge");
    const previewEl = document.getElementById("export-preview-status");
    const runBtn = document.getElementById("btn-run-harmonized-export");

    const populateExportYears = (includeAllOption) => {
      if (!yearSel) return;
      const prev = yearSel.value || String(GFIState.targetYear || 2026);
      yearSel.innerHTML = "";
      if (includeAllOption) {
        const allOpt = document.createElement("option");
        allOpt.value = "ALL";
        allOpt.textContent = "All Years (2001–2026)";
        yearSel.appendChild(allOpt);
      }
      for (let y = 2026; y >= 2001; y -= 1) {
        const opt = document.createElement("option");
        opt.value = String(y);
        opt.textContent = String(y);
        yearSel.appendChild(opt);
      }
      if ([...yearSel.options].some((o) => o.value === prev)) {
        yearSel.value = prev;
      } else {
        yearSel.value = String(GFIState.targetYear || 2026);
      }
    };

    const buildExportQuery = () => {
      const qs = new URLSearchParams({
        dataset: expState.dataset,
        region_code: expState.regionCode || "ALL",
        scope: expState.scope,
      });
      if (expState.scope === "full_year") {
        qs.set("year", yearSel?.value || String(GFIState.targetYear || 2026));
      } else if (expState.scope === "full_month") {
        qs.set("year", yearSel?.value || String(GFIState.targetYear || 2026));
        qs.set("month", monthSel?.value || String(GFIState.targetMonth || 1));
      } else if (expState.scope === "specific_date" && singleDateEl?.value) {
        qs.set("date", singleDateEl.value);
      } else if (expState.scope === "date_range") {
        if (startDateEl?.value) qs.set("start_date", startDateEl.value);
        if (endDateEl?.value) qs.set("end_date", endDateEl.value);
      }
      if (expState.bbox && expState.dataset === "events") {
        qs.set("min_lat", String(expState.bbox.minLat));
        qs.set("max_lat", String(expState.bbox.maxLat));
        qs.set("min_lon", String(expState.bbox.minLon));
        qs.set("max_lon", String(expState.bbox.maxLon));
      }
      return qs;
    };

    let previewTimer = null;
    const refreshExportPreview = () => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(async () => {
        if (!previewEl) return;
        previewEl.textContent = "Querying Chokí harmonized archive...";
        try {
          const qs = buildExportQuery();
          const res = await apiFetch(`/api/export/harmonized/preview?${qs.toString()}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          const cnt = Number(data.count || 0);
          const layerTxt = data.dataset === "series" ? "harmonized monthly records" : "harmonized co-located fire events";
          if (cnt === 0) {
            previewEl.textContent = `0 ${layerTxt} match this filter — try expanding date range or choosing Monthly Series.`;
          } else if (data.truncated) {
            previewEl.textContent = `${cnt.toLocaleString()} ${layerTxt} match (${Number(data.limit).toLocaleString()} max per file; filter by region or month for 100%).`;
          } else {
            previewEl.textContent = `Ready: ${cnt.toLocaleString()} ${layerTxt} • ${data.region_name || data.region_code} (${data.period_label})`;
          }
        } catch (err) {
          previewEl.textContent = `Preview unavailable (${err.message})`;
        }
      }, 120);
    };

    const syncExportModalUI = () => {
      const ctrlWrap = document.getElementById("export-ctrl-year-month");
      const wrapYear = document.getElementById("export-wrap-year");
      const wrapMonth = document.getElementById("export-wrap-month");
      const wrapDate = document.getElementById("export-wrap-single-date");
      const wrapRange = document.getElementById("export-wrap-date-range");

      if (expState.scope === "all_years") {
        if (ctrlWrap) ctrlWrap.style.display = "none";
      } else {
        if (ctrlWrap) ctrlWrap.style.display = "flex";
        if (expState.scope === "full_month") populateExportYears(true);
        else if (expState.scope === "full_year") populateExportYears(false);
        if (wrapYear) wrapYear.style.display = (expState.scope === "full_year" || expState.scope === "full_month") ? "flex" : "none";
        if (wrapMonth) wrapMonth.style.display = expState.scope === "full_month" ? "flex" : "none";
        if (wrapDate) wrapDate.style.display = expState.scope === "specific_date" ? "flex" : "none";
        if (wrapRange) wrapRange.style.display = expState.scope === "date_range" ? "flex" : "none";
      }
      if (regionBadgeEl) {
        regionBadgeEl.textContent = expState.bbox
          ? `Scope: ${expState.regionLabel} (Bounding Box + Nearest ${expState.regionCode})`
          : `Scope: ${expState.regionLabel} (${expState.regionCode})`;
      }
      refreshExportPreview();
    };

    bindInlineLocationSearch("export-location-search", "export-location-dropdown", (pick) => {
      expState.regionCode = pick.regionCode || pick.resolvedRegion || "ALL";
      expState.regionLabel = pick.name || expState.regionCode;
      if (!pick.regionCode && Number.isFinite(pick.lat) && Number.isFinite(pick.lon)) {
        expState.bbox = {
          minLat: Number((pick.lat - 2.5).toFixed(3)),
          maxLat: Number((pick.lat + 2.5).toFixed(3)),
          minLon: Number((pick.lon - 2.5).toFixed(3)),
          maxLon: Number((pick.lon + 2.5).toFixed(3)),
        };
      } else {
        expState.bbox = null;
      }
      syncExportModalUI();
    });

    exportModal.querySelectorAll("[data-exp-dataset]").forEach((btn) => {
      btn.addEventListener("click", () => {
        expState.dataset = btn.getAttribute("data-exp-dataset") || "events";
        exportModal.querySelectorAll("[data-exp-dataset]").forEach((b) => b.classList.toggle("active", b === btn));
        syncExportModalUI();
      });
    });

    exportModal.querySelectorAll("[data-exp-scope]").forEach((btn) => {
      btn.addEventListener("click", () => {
        expState.scope = btn.getAttribute("data-exp-scope") || "full_year";
        exportModal.querySelectorAll("[data-exp-scope]").forEach((b) => b.classList.toggle("active", b === btn));
        if ((expState.scope === "specific_date" || expState.scope === "date_range") && expState.dataset !== "events") {
          expState.dataset = "events";
          exportModal.querySelectorAll("[data-exp-dataset]").forEach((b) => {
            b.classList.toggle("active", b.getAttribute("data-exp-dataset") === "events");
          });
        }
        syncExportModalUI();
      });
    });

    exportModal.querySelectorAll("[data-exp-format]").forEach((btn) => {
      btn.addEventListener("click", () => {
        expState.format = btn.getAttribute("data-exp-format") || "csv";
        exportModal.querySelectorAll("[data-exp-format]").forEach((b) => b.classList.toggle("active", b === btn));
      });
    });

    [yearSel, monthSel, singleDateEl, startDateEl, endDateEl].forEach((el) => {
      el?.addEventListener("change", () => refreshExportPreview());
    });

    const closeExportModal = () => {
      exportModal.style.display = "none";
    };

    document.getElementById("btn-open-export-modal")?.addEventListener("click", () => {
      populateExportYears(expState.scope === "full_month");
      const activeReg = GFIState.regionCode || "ALL";
      const regObj = (GFIState.regions || []).find((r) => r.region_code === activeReg);
      expState.regionCode = activeReg;
      expState.regionLabel = activeReg === "ALL" ? "Global (All Regions)" : (regObj?.name || activeReg);
      expState.bbox = null;
      if (locSearchEl) locSearchEl.value = expState.regionLabel;
      if (yearSel && GFIState.targetYear) yearSel.value = String(GFIState.targetYear);
      if (monthSel && GFIState.targetMonth) monthSel.value = String(GFIState.targetMonth);
      exportModal.style.display = "flex";
      syncExportModalUI();
    });

    document.getElementById("btn-close-export-modal")?.addEventListener("click", closeExportModal);
    document.getElementById("btn-cancel-export-modal")?.addEventListener("click", closeExportModal);
    exportModal.addEventListener("click", (e) => {
      if (e.target === exportModal) closeExportModal();
    });

    runBtn?.addEventListener("click", async () => {
      const origTxt = runBtn.textContent;
      runBtn.disabled = true;
      runBtn.textContent = "Generating...";
      try {
        const qs = buildExportQuery();
        const ext = expState.format === "geojson" ? "geojson" : "csv";
        const res = await apiFetch(`/api/export/harmonized.${ext}?${qs.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const disp = res.headers.get("Content-Disposition") || "";
        const m = disp.match(/filename="([^"]+)"/);
        const fname = m ? m[1] : `Choki_Harmonized_${expState.regionCode}.${ext}`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        closeExportModal();
      } catch (err) {
        if (previewEl) previewEl.textContent = `Export failed: ${err.message}`;
      } finally {
        runBtn.disabled = false;
        runBtn.textContent = origTxt;
      }
    });
  }

  document.getElementById("btn-close-search-modal")?.addEventListener("click", () => {
    if (searchModal) searchModal.style.display = "none";
  });
  document.getElementById("btn-clear-location-search")?.addEventListener("click", () => {
    if (searchInput) {
      searchInput.value = "";
      searchInput.focus();
    }
    renderSearchResults(OFFLINE_GAZETTEER.slice(0, 6));
  });
  document.getElementById("btn-run-location-search")?.addEventListener("click", () => runLocationSearch());
  searchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runLocationSearch();
  });
  searchInput?.addEventListener("input", () => {
    const v = (searchInput.value || "").trim();
    if (v.length >= 2) runLocationSearch(v);
  });
  document.getElementById("btn-pick-map-location")?.addEventListener("click", () => {
    if (searchModal) searchModal.style.display = "none";
    setTool("pick_loc");
  });
  document.getElementById("btn-loc-use-gps")?.addEventListener("click", () => {
    if (searchModal) searchModal.style.display = "none";
    locateAndMonitorUserArea(true);
  });
  document.getElementById("btn-loc-scan-now")?.addEventListener("click", () => {
    if (searchModal) searchModal.style.display = "none";
    runSwathWatchdogCycle(true);
  });
  document.getElementById("btn-save-current-view")?.addEventListener("click", () => {
    const map = GFIState.map.mainInstance;
    const c = map ? map.getCenter() : { lat: 28.633, lng: -106.069 };
    const lat = Number(c.lat.toFixed(4));
    const lon = Number(c.lng.toFixed(4));
    const label = monitoredUserCoords?.sourceLabel || `Map View (${lat}°, ${lon}°)`;
    const list = loadSavedLocationsList();
    list.unshift({ name: label, lat, lon });
    saveLocationsList(list);
    renderSavedLocations();
  });

  // NASA FIRMS Hamburger Side Drawer & Tutorials Modal
  const firmsDrawer = document.getElementById("firms-drawer-backdrop");
  const tutorialsModal = document.getElementById("tutorials-info-modal");
  const alertsConfigModal = document.getElementById("fire-alerts-config-modal");

  const openTutorialsModal = (tabId = "how-to") => {
    if (!tutorialsModal) return;
    const validTab = ["how-to", "faqs", "alerts-guide"].includes(tabId) ? tabId : "how-to";
    tutorialsModal.style.display = "flex";
    document.querySelectorAll("#tutorials-tabs-bar [data-tuttab]").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-tuttab") === validTab);
    });
    const pHow = document.getElementById("tut-pane-how-to");
    const pFaqs = document.getElementById("tut-pane-faqs");
    const pAlerts = document.getElementById("tut-pane-alerts-guide");
    if (pHow) pHow.style.display = validTab === "how-to" ? "block" : "none";
    if (pFaqs) pFaqs.style.display = validTab === "faqs" ? "block" : "none";
    if (pAlerts) pAlerts.style.display = validTab === "alerts-guide" ? "block" : "none";
  };

  document.getElementById("btn-open-tutorials")?.addEventListener("click", () => openTutorialsModal("how-to"));
  document.getElementById("btn-close-tutorials-modal")?.addEventListener("click", () => {
    if (tutorialsModal) tutorialsModal.style.display = "none";
  });
  tutorialsModal?.addEventListener("click", (e) => {
    if (e.target === tutorialsModal) tutorialsModal.style.display = "none";
  });
  document.querySelectorAll("#tutorials-tabs-bar [data-tuttab]").forEach((btn) => {
    btn.addEventListener("click", () => openTutorialsModal(btn.getAttribute("data-tuttab")));
  });
  document.getElementById("btn-tut-open-alert-cfg")?.addEventListener("click", () => {
    if (tutorialsModal) tutorialsModal.style.display = "none";
    if (alertsConfigModal) alertsConfigModal.style.display = "flex";
  });
  document.getElementById("btn-tut-open-science")?.addEventListener("click", () => {
    if (tutorialsModal) tutorialsModal.style.display = "none";
    switchView("methodology");
  });

  document.getElementById("btn-open-firms-drawer")?.addEventListener("click", () => {
    if (firmsDrawer) firmsDrawer.style.display = "flex";
  });
  document.getElementById("btn-close-firms-drawer")?.addEventListener("click", () => {
    if (firmsDrawer) firmsDrawer.style.display = "none";
  });
  firmsDrawer?.addEventListener("click", (e) => {
    if (e.target === firmsDrawer) firmsDrawer.style.display = "none";
  });

  document.querySelectorAll(".firms-drawer-item[data-drawer-action]").forEach((item) => {
    item.addEventListener("click", () => {
      const action = item.getAttribute("data-drawer-action");
      if (firmsDrawer) firmsDrawer.style.display = "none";
      if (action === "firms-data-api") {
        window.open("https://firms.modaps.eosdis.nasa.gov/api/area/", "_blank", "noopener,noreferrer");
      } else if (action === "fire-alerts") {
        if (alertsConfigModal) alertsConfigModal.style.display = "flex";
      } else if (action === "tutorials") {
        openTutorialsModal("how-to");
      } else if (action === "faqs") {
        openTutorialsModal("faqs");
      }
    });
  });

  // Top-right quick GPS Re-center button
  document.getElementById("btn-recenter-location")?.addEventListener("click", () => {
    if (monitoredUserCoords) {
      flyToUserLocation(1050);
    } else {
      locateAndMonitorUserArea(true);
    }
  });

  // Segmented 3D Globe / 2D Flat + Satellite / Tactical Dark switches
  const syncProjectionButtons = () => {
    document.getElementById("btn-proj-globe")?.classList.toggle("active", GFIState.map.projectionMode === "globe");
    document.getElementById("btn-proj-flat")?.classList.toggle("active", GFIState.map.projectionMode === "mercator");
    document.getElementById("btn-base-satellite")?.classList.toggle("active", GFIState.map.basemapMode === "satellite");
    document.getElementById("btn-base-dark")?.classList.toggle("active", GFIState.map.basemapMode === "dark");
  };

  const setProjectionMode = (proj) => {
    GFIState.map.projectionMode = proj;
    syncProjectionButtons();
    const m = GFIState.map.mainInstance;
    if (m) {
      try {
        m.setProjection({ type: proj });
        m.setMinZoom(1.75);
        m.setMaxZoom(16);
        if (m.getZoom() < 1.75) m.setZoom(1.75);
      } catch (_) {}
    }
  };

  const setBasemapMode = (basemap) => {
    if (GFIState.map.basemapMode === basemap) return;
    GFIState.map.basemapMode = basemap;
    syncProjectionButtons();
    const m = GFIState.map.mainInstance;
    if (m) {
      m.setStyle(buildMapLibreStyle(basemap));
      m.once("style.load", () => {
        try { m.setProjection({ type: GFIState.map.projectionMode }); } catch (_) {}
        syncNightEarthLayer();
      });
    }
  };

  document.getElementById("btn-proj-globe")?.addEventListener("click", () => setProjectionMode("globe"));
  document.getElementById("btn-proj-flat")?.addEventListener("click", () => setProjectionMode("mercator"));
  document.getElementById("btn-base-satellite")?.addEventListener("click", () => setBasemapMode("satellite"));
  document.getElementById("btn-base-dark")?.addEventListener("click", () => setBasemapMode("dark"));

  document.getElementById("map-time-scope")?.addEventListener("change", async () => {
    syncNightEarthLayer();
    syncBboxStatusBadge();
    await loadSpatialHotspots();
  });

  initCustomFilterPickers();
  initBboxCoordsModal();
  initTimelineCalendarModal();

  let frpDebounceTimer = null;
  document.getElementById("map-filter-frp")?.addEventListener("change", () => {
    loadSpatialHotspots();
  });
  document.getElementById("map-filter-frp")?.addEventListener("input", () => {
    clearTimeout(frpDebounceTimer);
    frpDebounceTimer = setTimeout(() => {
      loadSpatialHotspots();
    }, 320);
  });

  initCustomFilterPickers();
  initBboxCoordsModal();
  initTimelineCalendarModal();

  // FIRMS Floating Tabbed Pixel Popup controls & attached sensor viñeta
  document.getElementById("btn-close-firms-popup")?.addEventListener("click", () => {
    document.getElementById("firms-pixel-popup")?.classList.add("popup-collapsed");
  });

  document.getElementById("tab-toggle-sensor-popup")?.addEventListener("click", () => {
    document.getElementById("firms-pixel-popup")?.classList.toggle("popup-collapsed");
  });

  document.querySelectorAll("#firms-popup-tabs .firms-sensor-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const sat = tab.dataset.sat;
      if (!sat) return;
      GFIState.firmsPopupActiveSat = sat;
      document.querySelectorAll("#firms-popup-tabs .firms-sensor-tab").forEach((t) => {
        t.classList.toggle("active", t === tab);
      });
      populateFirmsPopupDates(sat);
      renderFirmsPopupTable(sat);
    });
  });

  document.querySelectorAll('input[name="firms-popup-tz"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      renderFirmsPopupTable(GFIState.firmsPopupActiveSat || "NOAA-20");
    });
  });

  document.getElementById("firms-popup-filter-text")?.addEventListener("input", () => {
    renderFirmsPopupTable(GFIState.firmsPopupActiveSat || "NOAA-20");
  });
  document.getElementById("firms-popup-filter-field")?.addEventListener("change", () => {
    renderFirmsPopupTable(GFIState.firmsPopupActiveSat || "NOAA-20");
  });
  document.getElementById("firms-popup-filter-date")?.addEventListener("change", () => {
    renderFirmsPopupTable(GFIState.firmsPopupActiveSat || "NOAA-20");
    if (GFIState.map.layers?.clouds) {
      syncEnvironmentalLayers();
    }
  });
}

const HUD_PICKER_META = {
  "map-filter-instrument": {
    title: "Select Orbital Sensor",
    options: {
      ALL: { icon: "🛰️", desc: "Combine MODIS (1 km) & VIIRS (375 m) harmonized detections" },
      MODIS: { icon: "📡", desc: "Terra & Aqua 1 km thermal infrared channels" },
      VIIRS: { icon: "🔥", desc: "NOAA-20, NOAA-21 & S-NPP high-resolution 375 m pixels" },
    },
  },
  "map-filter-confidence": {
    title: "Select Detection Confidence",
    options: {
      ALL: { icon: "🌐", desc: "Include low, nominal, and high confidence thermal alerts" },
      Nominal: { icon: "✓", desc: "Balanced operational filter (Nominal + High confidence)" },
      High: { icon: "🎯", desc: "Strict high-confidence active fire plumes only" },
    },
  },
  "map-filter-satellite": {
    title: "Select Satellite Platform",
    options: {
      ALL: { icon: "🛸", desc: "All active NRT constellations & historical archives" },
      "NOAA-20": { icon: "⚡", desc: "JPSS-1 VIIRS Near-Real-Time orbital swaths" },
      "NOAA-21": { icon: "⚡", desc: "JPSS-2 VIIRS Near-Real-Time orbital swaths" },
      "Suomi-NPP": { icon: "📜", desc: "Suomi National Polar-orbiting Partnership archive" },
      Aqua: { icon: "🌊", desc: "NASA EOS-Aqua afternoon MODIS overpass" },
      Terra: { icon: "🌍", desc: "NASA EOS-Terra morning MODIS overpass" },
    },
  },
  "map-filter-daynight": {
    title: "Select Orbital Cycle",
    options: {
      ALL: { icon: "🌗", desc: "Standard planet view with both daytime & nighttime fires" },
      D: { icon: "☀️", desc: "Daytime solar-illuminated orbital overpasses only" },
      N: { icon: "🌙", desc: "Earth at Night (NASA Black Marble city lights) + nocturnal fires" },
    },
  },
};

function syncCustomFilterButtons() {
  document.querySelectorAll(".hud-custom-select-btn[data-picker-target]").forEach((btn) => {
    const targetId = btn.getAttribute("data-picker-target");
    const sel = targetId ? document.getElementById(targetId) : null;
    if (!sel) return;
    const selectedOpt = sel.options[sel.selectedIndex];
    const textEl = btn.querySelector(".hud-custom-select-text");
    if (textEl && selectedOpt) {
      textEl.textContent = selectedOpt.textContent;
    }
  });
}

function initCustomFilterPickers() {
  const modal = document.getElementById("hud-filter-picker-modal");
  const titleEl = document.getElementById("hud-picker-title");
  const listEl = document.getElementById("hud-picker-options-list");
  const closeBtn = document.getElementById("btn-close-hud-picker");
  if (!modal || !titleEl || !listEl) return;

  const closeModal = () => {
    modal.style.display = "none";
  };

  closeBtn?.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.style.display === "flex") closeModal();
  });

  const openPickerFor = (targetId) => {
    const sel = document.getElementById(targetId);
    if (!sel) return;
    const meta = HUD_PICKER_META[targetId] || { title: "Select Option", options: {} };
    titleEl.textContent = meta.title;
    listEl.replaceChildren();

    Array.from(sel.options).forEach((opt) => {
      const optMeta = meta.options[opt.value] || {};
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `hud-picker-option-btn${opt.value === sel.value ? " selected" : ""}`;
      btn.innerHTML = `
        <div class="hud-picker-opt-left">
          <span class="hud-picker-opt-icon">${optMeta.icon || "•"}</span>
          <div class="hud-picker-opt-copy">
            <span class="hud-picker-opt-title">${escapeHtml(opt.textContent)}</span>
            ${optMeta.desc ? `<span class="hud-picker-opt-desc">${escapeHtml(optMeta.desc)}</span>` : ""}
          </div>
        </div>
        <span class="hud-picker-opt-check">✓</span>
      `;
      btn.addEventListener("click", async () => {
        sel.value = opt.value;
        syncCustomFilterButtons();
        closeModal();
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        if (targetId === "map-filter-daynight") {
          syncNightEarthLayer();
        }
        await loadSpatialHotspots();
      });
      listEl.appendChild(btn);
    });

    modal.style.display = "flex";
  };

  document.querySelectorAll(".hud-custom-select-btn[data-picker-target]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-picker-target");
      if (targetId) openPickerFor(targetId);
    });
  });

  syncCustomFilterButtons();
}

function syncBboxStatusBadge() {
  const badge = document.getElementById("hud-bbox-status-badge");
  if (!badge) return;
  const hasBbox = Boolean(GFIState.map.customBBox);
  badge.textContent = hasBbox ? "Active" : "Global";
  badge.classList.toggle("active", hasBbox);
}

function initBboxCoordsModal() {
  const modal = document.getElementById("bbox-coords-modal");
  const openBtn = document.getElementById("btn-open-bbox-modal");
  const closeBtn = document.getElementById("btn-close-bbox-modal");
  const useViewBtn = document.getElementById("btn-bbox-use-viewport");
  const clearBtn = document.getElementById("btn-bbox-clear");
  const applyBtn = document.getElementById("btn-bbox-apply-modal");
  if (!modal || !openBtn) return;

  const closeModal = () => {
    modal.style.display = "none";
  };

  openBtn.addEventListener("click", () => {
    modal.style.display = "flex";
  });
  closeBtn?.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.style.display === "flex") closeModal();
  });

  useViewBtn?.addEventListener("click", () => {
    const m = GFIState.map.mainInstance;
    if (!m) return;
    const b = m.getBounds();
    document.getElementById("bbox-min-lat").value = b.getSouth().toFixed(2);
    document.getElementById("bbox-max-lat").value = b.getNorth().toFixed(2);
    document.getElementById("bbox-min-lon").value = b.getWest().toFixed(2);
    document.getElementById("bbox-max-lon").value = b.getEast().toFixed(2);
  });

  clearBtn?.addEventListener("click", async () => {
    GFIState.map.customBBox = null;
    ["bbox-min-lat", "bbox-max-lat", "bbox-min-lon", "bbox-max-lon"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    updateSelectionOverlay();
    syncBboxStatusBadge();
    closeModal();
    await loadSpatialHotspots();
  });

  applyBtn?.addEventListener("click", async () => {
    const minLat = parseFloat(document.getElementById("bbox-min-lat").value);
    const maxLat = parseFloat(document.getElementById("bbox-max-lat").value);
    const minLon = parseFloat(document.getElementById("bbox-min-lon").value);
    const maxLon = parseFloat(document.getElementById("bbox-max-lon").value);
    if (!isNaN(minLat) && !isNaN(maxLat) && !isNaN(minLon) && !isNaN(maxLon)) {
      GFIState.map.customBBox = {
        minLat: Math.min(minLat, maxLat),
        maxLat: Math.max(minLat, maxLat),
        minLon: Math.min(minLon, maxLon),
        maxLon: Math.max(minLon, maxLon),
      };
      updateSelectionOverlay();
      GFIState.map.mainInstance?.fitBounds(
        [
          [GFIState.map.customBBox.minLon, GFIState.map.customBBox.minLat],
          [GFIState.map.customBBox.maxLon, GFIState.map.customBBox.maxLat],
        ],
        { padding: 60, duration: 900 }
      );
    }
    syncBboxStatusBadge();
    closeModal();
    await loadSpatialHotspots();
  });

  syncBboxStatusBadge();
}

function initTimelineCalendarModal() {
  const triggerBtn = document.getElementById("timeline-active-date-pill");
  const modal = document.getElementById("timeline-calendar-modal");
  const closeBtn = document.getElementById("btn-close-cal-modal");
  const prevBtn = document.getElementById("btn-cal-prev-month");
  const nextBtn = document.getElementById("btn-cal-next-month");
  const monthSel = document.getElementById("cal-modal-month-sel");
  const yearSel = document.getElementById("cal-modal-year-sel");
  const gridEl = document.getElementById("cal-modal-days-grid");
  const todayBtn = document.getElementById("btn-cal-today");
  const fullMonthBtn = document.getElementById("btn-cal-full-month");
  if (!triggerBtn || !modal || !monthSel || !yearSel || !gridEl) return;

  let viewYear = GFIState.targetYear || new Date().getFullYear();
  let viewMonth = GFIState.targetMonth || (new Date().getMonth() + 1);

  const closeModal = () => {
    modal.style.display = "none";
  };

  const renderCalendar = () => {
    const now = new Date();
    const todayY = now.getFullYear();
    const todayM = now.getMonth() + 1;
    const todayD = now.getDate();

    yearSel.replaceChildren();
    for (let y = todayY; y >= 2001; y--) {
      const opt = document.createElement("option");
      opt.value = String(y);
      opt.textContent = String(y);
      if (y === viewYear) opt.selected = true;
      yearSel.appendChild(opt);
    }

    monthSel.replaceChildren();
    for (let m = 1; m <= 12; m++) {
      const opt = document.createElement("option");
      opt.value = String(m);
      opt.textContent = MONTH_FULL_UPPER[m - 1];
      if (viewYear === todayY && m > todayM) opt.disabled = true;
      if (m === viewMonth) opt.selected = true;
      monthSel.appendChild(opt);
    }

    if (nextBtn) {
      nextBtn.disabled = viewYear > todayY || (viewYear === todayY && viewMonth >= todayM);
    }
    if (prevBtn) {
      prevBtn.disabled = viewYear <= 2001 && viewMonth <= 1;
    }

    const firstWeekday = new Date(Date.UTC(viewYear, viewMonth - 1, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(viewYear, viewMonth, 0)).getUTCDate();

    gridEl.replaceChildren();
    for (let i = 0; i < firstWeekday; i++) {
      const spacer = document.createElement("div");
      gridEl.appendChild(spacer);
    }

    const selY = GFIState.targetYear;
    const selM = GFIState.targetMonth;
    const selD = GFIState.targetDay === "ALL" ? null : parseInt(GFIState.targetDay, 10);

    for (let d = 1; d <= daysInMonth; d++) {
      const isFuture =
        viewYear > todayY ||
        (viewYear === todayY && viewMonth > todayM) ||
        (viewYear === todayY && viewMonth === todayM && d > todayD);
      const isToday = viewYear === todayY && viewMonth === todayM && d === todayD;
      const isSelected = viewYear === selY && viewMonth === selM && selD === d;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cal-modal-day";
      if (isToday) btn.classList.add("today");
      if (isSelected) btn.classList.add("selected");
      if (isFuture) {
        btn.classList.add("disabled");
        btn.disabled = true;
      }
      btn.textContent = String(d);
      btn.addEventListener("click", async () => {
        if (isFuture) return;
        GFIState.targetYear = viewYear;
        GFIState.targetMonth = viewMonth;
        GFIState.targetDay = String(d);
        const stepSel = document.getElementById("timeline-step-mode");
        if (stepSel && stepSel.value === "month") stepSel.value = "day";
        closeModal();
        ensureDateDrivenMapScope();
        syncBottomMonthPills();
        await refreshAllActiveData();
      });
      gridEl.appendChild(btn);
    }
  };

  triggerBtn.addEventListener("click", () => {
    const now = new Date();
    viewYear = Math.min(now.getFullYear(), GFIState.targetYear || now.getFullYear());
    viewMonth = GFIState.targetMonth || (now.getMonth() + 1);
    if (viewYear === now.getFullYear() && viewMonth > now.getMonth() + 1) {
      viewMonth = now.getMonth() + 1;
    }
    renderCalendar();
    modal.style.display = "flex";
  });

  closeBtn?.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.style.display === "flex") closeModal();
  });

  prevBtn?.addEventListener("click", () => {
    viewMonth -= 1;
    if (viewMonth < 1) {
      viewMonth = 12;
      viewYear = Math.max(2001, viewYear - 1);
    }
    renderCalendar();
  });

  nextBtn?.addEventListener("click", () => {
    const now = new Date();
    let nextM = viewMonth + 1;
    let nextY = viewYear;
    if (nextM > 12) {
      nextM = 1;
      nextY += 1;
    }
    if (nextY > now.getFullYear() || (nextY === now.getFullYear() && nextM > now.getMonth() + 1)) {
      return;
    }
    viewYear = nextY;
    viewMonth = nextM;
    renderCalendar();
  });

  yearSel.addEventListener("change", () => {
    const now = new Date();
    viewYear = parseInt(yearSel.value, 10) || now.getFullYear();
    if (viewYear === now.getFullYear() && viewMonth > now.getMonth() + 1) {
      viewMonth = now.getMonth() + 1;
    }
    renderCalendar();
  });

  monthSel.addEventListener("change", () => {
    viewMonth = parseInt(monthSel.value, 10) || 1;
    renderCalendar();
  });

  todayBtn?.addEventListener("click", async () => {
    const now = new Date();
    GFIState.targetYear = now.getFullYear();
    GFIState.targetMonth = now.getMonth() + 1;
    GFIState.targetDay = String(now.getDate());
    const stepSel = document.getElementById("timeline-step-mode");
    if (stepSel && stepSel.value === "month") stepSel.value = "day";
    closeModal();
    ensureDateDrivenMapScope();
    syncBottomMonthPills();
    await refreshAllActiveData();
  });

  fullMonthBtn?.addEventListener("click", async () => {
    GFIState.targetYear = viewYear;
    GFIState.targetMonth = viewMonth;
    GFIState.targetDay = "ALL";
    const stepSel = document.getElementById("timeline-step-mode");
    if (stepSel) stepSel.value = "month";
    closeModal();
    ensureDateDrivenMapScope();
    syncBottomMonthPills();
    await refreshAllActiveData();
  });
}

const FIRMS_TAB_LABELS = {
  Terra: "MODIS<br/>Terra [1km]",
  Aqua: "MODIS<br/>Aqua [1km]",
  "NOAA-20": "VIIRS<br/>NOAA-20 [375m]",
  "NOAA-21": "VIIRS<br/>NOAA-21 [375m]",
  "Suomi-NPP": "VIIRS<br/>S-NPP [375m]",
};

function normalizeFirmsSatKey(sat) {
  if (!sat) return "NOAA-20";
  const s = String(sat).trim();
  if (s === "S-NPP" || s === "SNPP" || s === "NPP") return "Suomi-NPP";
  if (s === "N20") return "NOAA-20";
  if (s === "N21") return "NOAA-21";
  return s;
}

function populateFirmsPopupDates(satKey) {
  const dateSel = document.getElementById("firms-popup-filter-date");
  if (!dateSel) return;
  const rows = (GFIState.firmsPopupGrouped && GFIState.firmsPopupGrouped[satKey]) || [];
  const tzMode = document.querySelector('input[name="firms-popup-tz"]:checked')?.value || "local";
  const dates = Array.from(
    new Set(rows.map((r) => formatAcquisitionTimestamp(r.acq_date, r.acq_time, tzMode).slice(0, 10)).filter(Boolean))
  ).sort().reverse();

  const prev = dateSel.value;
  dateSel.replaceChildren();
  const optAll = document.createElement("option");
  optAll.value = "ALL";
  optAll.textContent = "All dates";
  dateSel.appendChild(optAll);
  dates.forEach((d) => {
    const o = document.createElement("option");
    o.value = d;
    o.textContent = d;
    dateSel.appendChild(o);
  });
  dateSel.value = dates.includes(prev) ? prev : "ALL";
}

function renderFirmsPopupTable(satKey) {
  const table = document.getElementById("firms-popup-table");
  if (!table) return;
  const allRows = (GFIState.firmsPopupGrouped && GFIState.firmsPopupGrouped[satKey]) || [];
  const tzMode = document.querySelector('input[name="firms-popup-tz"]:checked')?.value || "local";
  const qText = (document.getElementById("firms-popup-filter-text")?.value || "").trim().toLowerCase();
  const field = document.getElementById("firms-popup-filter-field")?.value || "all";
  const dateFilter = document.getElementById("firms-popup-filter-date")?.value || "ALL";

  const rows = allRows.filter((r) => {
    const formattedTs = formatAcquisitionTimestamp(r.acq_date, r.acq_time, tzMode);
    if (dateFilter !== "ALL" && formattedTs.slice(0, 10) !== dateFilter) return false;
    if (!qText) return true;
    const mapFields = {
      latitude: Number(r.latitude).toFixed(5),
      longitude: Number(r.longitude).toFixed(5),
      bright_mir: String(r.bright_mir ?? ""),
      scan: String(r.scan ?? ""),
      track: String(r.track ?? ""),
      acquire_time: formattedTs,
      satellite: String(r.satellite || satKey),
      instrument: String(r.instrument || ""),
      confidence: String(r.confidence_raw ?? r.confidence_tier ?? ""),
      frp: String(r.frp ?? ""),
      daynight: String(r.daynight || ""),
    };
    if (field !== "all" && mapFields[field] !== undefined) {
      return mapFields[field].toLowerCase().includes(qText);
    }
    return Object.values(mapFields).some((v) => v.toLowerCase().includes(qText));
  });

  const headerHtml = `
    <thead>
      <tr>
        <th>LAT</th>
        <th>LON</th>
        <th>MIR (K)</th>
        <th>SCAN</th>
        <th>TRACK</th>
        <th>ACQUIRE TIME (${tzMode === "utc" ? "UTC" : "LOCAL"})</th>
        <th>SATELLITE</th>
        <th>SENSOR</th>
        <th>CONF</th>
        <th>VER</th>
        <th>TIR (K)</th>
        <th>FRP (MW)</th>
        <th>D/N</th>
      </tr>
    </thead>
  `;

  if (!rows.length) {
    table.innerHTML = `
      ${headerHtml}
      <tbody>
        <tr><td colspan="13" style="text-align:center; padding:12px; color:#94a3b8;">No matching detections for ${escapeHtml(satKey)}.</td></tr>
      </tbody>
    `;
    return;
  }

  const bodyHtml = rows
    .map((r) => {
      const acqFormatted = formatAcquisitionTimestamp(r.acq_date, r.acq_time, tzMode);
      return `
      <tr>
        <td>${Number(r.latitude).toFixed(5)}</td>
        <td>${Number(r.longitude).toFixed(5)}</td>
        <td>${escapeHtml(r.bright_mir ?? "—")}</td>
        <td>${escapeHtml(r.scan ?? "—")}</td>
        <td>${escapeHtml(r.track ?? "—")}</td>
        <td style="color:#fde68a;">${escapeHtml(acqFormatted)}</td>
        <td>${escapeHtml(r.satellite || satKey)}</td>
        <td>${escapeHtml(r.instrument || "—")}</td>
        <td>${escapeHtml(r.confidence_raw ?? r.confidence_tier ?? "—")}</td>
        <td>${escapeHtml(r.version ?? "—")}</td>
        <td>${escapeHtml(r.bright_tir ?? "—")}</td>
        <td style="font-weight:700; color:#fb923c;">${escapeHtml(r.frp ?? "—")}</td>
        <td>${escapeHtml(r.daynight || "—")}</td>
      </tr>
    `;
    })
    .join("");

  table.innerHTML = `${headerHtml}<tbody>${bodyHtml}</tbody>`;
}

function openFirmsPixelPopup(clickedHotspot, eventMembers) {
  const popup = document.getElementById("firms-pixel-popup");
  const tabsWrap = document.getElementById("firms-popup-tabs");
  if (!popup || !tabsWrap) return;

  const grouped = {
    Terra: [],
    Aqua: [],
    "NOAA-20": [],
    "NOAA-21": [],
    "Suomi-NPP": [],
  };

  const list = Array.isArray(eventMembers) && eventMembers.length ? eventMembers : [clickedHotspot];
  const seenIds = new Set();
  const addRecord = (rec) => {
    if (!rec) return;
    const rid = rec.hotspot_id ?? rec.id;
    if (rid !== undefined && rid !== null) {
      if (seenIds.has(rid)) return;
      seenIds.add(rid);
    }
    const key = normalizeFirmsSatKey(rec.satellite);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(rec);
  };

  list.forEach(addRecord);
  addRecord(clickedHotspot);

  GFIState.firmsPopupGrouped = grouped;

  const activeSat = normalizeFirmsSatKey(clickedHotspot?.satellite);
  GFIState.firmsPopupActiveSat = activeSat;
  let totalDetections = 0;
  tabsWrap.querySelectorAll(".firms-sensor-tab").forEach((tab) => {
    const sat = tab.dataset.sat;
    const count = (grouped[sat] || []).length;
    totalDetections += count;
    const baseLabel = FIRMS_TAB_LABELS[sat] || sat;
    tab.innerHTML = `${baseLabel}${count > 0 ? ` <span class="tab-count">[${count}]</span>` : ""}`;
    tab.classList.toggle("active", sat === activeSat);
  });

  const tabLabelEl = document.getElementById("sensor-tab-label-text");
  if (tabLabelEl) {
    tabLabelEl.textContent = totalDetections > 0 ? `SENSORS [${totalDetections}]` : "SENSORS";
  }

  populateFirmsPopupDates(activeSat);
  renderFirmsPopupTable(activeSat);
  popup.classList.remove("popup-collapsed");
  popup.classList.add("active");
}

async function inspectHotspotDetails(h, zoneRecords = null, radiusKm = null) {
  const box = document.getElementById("hotspot-inspector-content");
  if (!box) return;

  let eventDetailsHtml = "";
  let eventMembers = [];
  if (h.thermal_event_id) {
    try {
      const evRes = await apiFetch(`/api/event/${h.thermal_event_id}`);
      if (evRes.ok) {
        const evData = await evRes.json();
        const ev = evData.event;
        const members = evData.constituent_detections || [];
        eventMembers = members;
        eventDetailsHtml = `
          <div class="sci-callout" style="margin-top:10px; border-left-color:#c084fc;">
            <strong>Co-located Thermal Event Provenance (#${ev.event_id}):</strong><br/>
            • Composition: <code>${ev.sensor_composition}</code> (${ev.modis_pixel_count} MODIS px + ${ev.viirs_pixel_count} VIIRS px)<br/>
            • Consolidated FRP (No Double Counting): <strong>${ev.consolidated_frp_mw} MW</strong><br/>
            • Integrated Satellite Pixels (${members.length}):
            <ul style="margin-top:4px; padding-left:16px; font-family:var(--font-mono); font-size:11px;">
              ${members.map((m) => `<li>[${m.instrument}/${m.satellite}] ${m.acq_time} UTC • FRP=${m.frp} MW • ${m.scan}×${m.track}km (Δd=${m.distance_to_centroid_km}km)</li>`).join("")}
            </ul>
          </div>
        `;
      }
    } catch (_) {}
  }

  GFIState.selectedZoneRecords = Array.isArray(zoneRecords) && zoneRecords.length > 0 ? zoneRecords : [h];
  GFIState.selectedZoneRadiusKm = radiusKm;
  GFIState.selectedHotspot = h;

  const activeIdx = Math.max(
    0,
    GFIState.selectedZoneRecords.findIndex(
      (r) => r === h || (r.id != null && h.id != null && String(r.id) === String(h.id))
    )
  );

  let zoneBannerHtml = "";
  if (Array.isArray(zoneRecords) && zoneRecords.length > 0) {
    const hasMultiple = zoneRecords.length > 1;
    const optionsHtml = hasMultiple
      ? zoneRecords
          .map((rec, idx) => {
            const tStr = formatAcquisitionTimestamp(rec.acq_date, rec.acq_time, "local").slice(11, 16) || "--:--";
            const frpStr = rec.frp != null ? `${Number(rec.frp).toFixed(1)} MW` : "—";
            const label = `#${idx + 1} • ${rec.instrument || "—"} ${rec.satellite || ""} • ${frpStr} • ${tStr}`;
            return `<option value="${idx}" ${idx === activeIdx ? "selected" : ""}>${escapeHtml(label)}</option>`;
          })
          .join("")
      : "";
    zoneBannerHtml = `
      <div class="sci-callout zone-inspector-banner">
        <div class="zone-inspector-top">
          <span><strong>Zone:</strong> ${radiusKm ?? "—"} km radius • <strong>${zoneRecords.length}</strong> detection${zoneRecords.length === 1 ? "" : "s"}</span>
          ${hasMultiple ? `<button type="button" class="zone-view-all-btn" id="btn-open-zone-modal">Select Point (${zoneRecords.length})</button>` : ""}
        </div>
        ${
          hasMultiple
            ? `<div class="zone-point-switcher">
                 <button type="button" class="zone-nav-btn" id="btn-zone-prev" title="Previous detection">‹</button>
                 <select id="zone-point-select" class="zone-point-select" aria-label="Select point in zone">${optionsHtml}</select>
                 <button type="button" class="zone-nav-btn" id="btn-zone-next" title="Next detection">›</button>
               </div>`
            : ""
        }
      </div>`;
  }

  const provHash = h.record_hash
    ? String(h.record_hash).slice(0, 10)
    : `GFI-${String(h.id ?? 0).padStart(6, "0")}`;
  const latNum = Number(h.latitude) || 0;
  const lonNum = Number(h.longitude) || 0;
  const mirNum = Number(h.bright_mir) || 0;
  const tirNum = Number(h.bright_tir) || 0;
  const gridKey = h.grid_1km_key || `G1K_${latNum.toFixed(2)}_${lonNum.toFixed(2)}`;

  const acqLocal24 = formatAcquisitionTimestamp(h.acq_date, h.acq_time, "local");
  const acqUtc24 = formatAcquisitionTimestamp(h.acq_date, h.acq_time, "utc");
  const acqLocalHh = parseInt(acqLocal24.slice(11, 13), 10);
  const acqLocalAmPm = !isNaN(acqLocalHh)
    ? `${acqLocal24.slice(0, 11)}${((acqLocalHh % 12) || 12).toString().padStart(2, "0")}:${acqLocal24.slice(14, 19)} ${acqLocalHh >= 12 ? "PM" : "AM"}`
    : acqLocal24;

  box.innerHTML = `
    ${zoneBannerHtml}
    <div id="auto-qc-strip-slot">
      <div class="qc-auto-strip">
        <div class="qc-auto-strip-header">
          <span>Fire Verification</span>
          <span style="font-size:10.5px; color:#94a3b8;">Screening pixels...</span>
        </div>
      </div>
    </div>
    <table class="anomaly-spotlight-table">
      <tbody>
        <tr><th>Event ID</th><td class="mono-val">#${h.id ?? "—"} • ${escapeHtml(provHash)}</td></tr>
        <tr><th>Sensor / Sat</th><td class="mono-val">${escapeHtml(h.instrument || "—")} • ${escapeHtml(h.satellite || "—")} (${escapeHtml(h.version || "2.0")})</td></tr>
        <tr><th>Coordinates</th><td class="mono-val">${latNum.toFixed(5)}°, ${lonNum.toFixed(5)}°</td></tr>
        <tr><th>Acquired</th><td class="mono-val">${escapeHtml(acqLocalAmPm)} Local<br/>${escapeHtml(acqUtc24)} UTC (${h.daynight === 'D' ? 'Day' : 'Night'})</td></tr>
        <tr><th>Confidence</th><td class="mono-val">${escapeHtml(h.confidence_tier ?? "Nominal")} (${h.confidence_score ?? 60}%)</td></tr>
        <tr><th>MIR / TIR</th><td class="mono-val">${mirNum} K / ${tirNum} K (ΔT ${(mirNum - tirNum).toFixed(1)} K)</td></tr>
        <tr><th>FRP</th><td class="mono-val" style="color:#fb923c;">${h.frp ?? 0} MW</td></tr>
        <tr><th>Footprint</th><td class="mono-val">${h.scan ?? 0.4} × ${h.track ?? 0.4} km (${h.pixel_area_km2 ?? 0.16} km²)</td></tr>
        <tr><th>Grid Cell</th><td class="mono-val">${escapeHtml(gridKey)}</td></tr>
        <tr><th>Source</th><td class="mono-val">${escapeHtml(h.source_provenance || "NASA_FIRMS")}</td></tr>
      </tbody>
    </table>
    ${eventDetailsHtml}
  `;

  const selectZoneIdx = (idx) => {
    const list = GFIState.selectedZoneRecords || [];
    if (!list.length) return;
    const wrapped = ((idx % list.length) + list.length) % list.length;
    const chosen = list[wrapped];
    if (chosen) {
      inspectHotspotDetails(chosen, list, GFIState.selectedZoneRadiusKm ?? radiusKm);
    }
  };

  document.getElementById("zone-point-select")?.addEventListener("change", (e) => {
    selectZoneIdx(parseInt(e.target.value, 10) || 0);
  });
  document.getElementById("btn-zone-prev")?.addEventListener("click", () => {
    selectZoneIdx(activeIdx - 1);
  });
  document.getElementById("btn-zone-next")?.addEventListener("click", () => {
    selectZoneIdx(activeIdx + 1);
  });
  document.getElementById("btn-open-zone-modal")?.addEventListener("click", () => {
    openZoneDetectionsModal();
  });

  // Silent automatic background QC check on the selected point or circle
  runSilentZoneQc(GFIState.selectedZoneRecords);

  const popupRecords =
    Array.isArray(zoneRecords) && zoneRecords.length > 0 ? zoneRecords : eventMembers;
  openFirmsPixelPopup(h, popupRecords);
}

function closeZoneDetectionsModal() {
  const modal = document.getElementById("zone-detections-modal");
  if (modal) modal.style.display = "none";
}

function openZoneDetectionsModal() {
  const modal = document.getElementById("zone-detections-modal");
  const tbody = document.getElementById("zone-modal-tbody");
  const sub = document.getElementById("zone-modal-subtitle");
  const list = GFIState.selectedZoneRecords || [];
  if (!modal || !tbody || !list.length) return;

  if (sub) {
    sub.textContent = `${GFIState.selectedZoneRadiusKm ?? "—"} km radius • ${list.length} thermal detection${list.length === 1 ? "" : "s"}`;
  }

  const active = GFIState.selectedHotspot;
  tbody.innerHTML = list
    .map((rec, idx) => {
      const isAct =
        active &&
        (rec === active || (rec.id != null && active.id != null && String(rec.id) === String(active.id)));
      const latS = Number(rec.latitude || 0).toFixed(4);
      const lonS = Number(rec.longitude || 0).toFixed(4);
      const tLocal = formatAcquisitionTimestamp(rec.acq_date, rec.acq_time, "local");
      const frpS = rec.frp != null ? `${Number(rec.frp).toFixed(1)} MW` : "—";
      const confS = `${rec.confidence_tier ?? "Nominal"} (${rec.confidence_score ?? 60}%)`;
      return `
        <tr class="zone-modal-row ${isAct ? "is-active" : ""}" data-zone-idx="${idx}">
          <td>#${idx + 1}</td>
          <td>${escapeHtml(rec.instrument || "—")} • ${escapeHtml(rec.satellite || "—")}</td>
          <td>${latS}°, ${lonS}°</td>
          <td>${escapeHtml(tLocal)}</td>
          <td style="color:#fb923c;">${frpS}</td>
          <td>${escapeHtml(confS)}</td>
          <td><button type="button" class="zone-view-all-btn" data-zone-pick="${idx}">${isAct ? "Active" : "Inspect"}</button></td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll("tr[data-zone-idx]").forEach((row) => {
    row.addEventListener("click", () => {
      const idx = parseInt(row.getAttribute("data-zone-idx"), 10);
      const chosen = list[idx];
      closeZoneDetectionsModal();
      if (chosen) {
        inspectHotspotDetails(chosen, list, GFIState.selectedZoneRadiusKm);
      }
    });
  });

  if (!modal.dataset.wired) {
    modal.dataset.wired = "1";
    document.getElementById("btn-close-zone-modal")?.addEventListener("click", closeZoneDetectionsModal);
    document.getElementById("btn-zone-modal-close-footer")?.addEventListener("click", closeZoneDetectionsModal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeZoneDetectionsModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal.style.display !== "none") closeZoneDetectionsModal();
    });
  }

  modal.style.display = "flex";
}

function renderMapSummaryBox() {
  const box = document.getElementById("map-summary-stats-box");
  if (!box || !GFIState.hotspotsData) return;
  const s = GFIState.hotspotsData.summary || {};
  let dayCount = s.daynight_d;
  let nightCount = s.daynight_n;
  if (dayCount == null || nightCount == null) {
    dayCount = 0;
    nightCount = 0;
    const rows = GFIState.hotspotsData.hotspots || [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i]?.daynight === "N") nightCount += 1;
      else dayCount += 1;
    }
  }

  box.innerHTML = `
    <table class="anomaly-spotlight-table">
      <tbody>
        <tr><th>Visible Hotspots</th><td class="mono-val">${formatInt(s.returned_records)}</td></tr>
        <tr><th>MODIS (1 km)</th><td class="mono-val" style="color:#38bdf8;">${formatInt(s.modis_detections)}</td></tr>
        <tr><th>VIIRS (375 m)</th><td class="mono-val" style="color:#fb923c;">${formatInt(s.viirs_detections)}</td></tr>
        <tr><th>Day / Night</th><td class="mono-val">${formatInt(dayCount)} / ${formatInt(nightCount)}</td></tr>
        <tr><th>Co-located Events</th><td class="mono-val" style="color:#c084fc;">${formatInt(s.colocated_thermal_events)}</td></tr>
        <tr><th>Dual-Sensor Confirmed</th><td class="mono-val">${formatInt(s.dual_sensor_coincident_events)}</td></tr>
        <tr><th>Mean FRP</th><td class="mono-val">${formatNum(s.mean_frp_mw)} MW</td></tr>
      </tbody>
    </table>
  `;
}

/* ==========================================================================
   6. HISTORICAL ANALYSIS, CALIBRATION MODELS & FINGERPRINT VIEW
   ========================================================================== */

function renderHistoricalAnalysisView() {
  const data = GFIState.overviewData;
  if (!data) return;

  const calYears = data.calendar.calendar_years || [];
  drawHarmonizationProofChart("chart-overview-harmonization-proof", calYears);

  const rowA = calYears.find((y) => y.year === GFIState.analysisYearA) || calYears[calYears.length - 1];
  const rowB = calYears.find((y) => y.year === GFIState.analysisYearB) || calYears[0];
  const baselines = data.calendar.monthly_baselines;

  // 1. Year A vs Year B Chart
  drawYearVsYearChart("chart-analysis-year-vs-year", rowA, rowB, baselines);

  // 2. Historical Fire Fingerprint Chart & Summary
  const fp = data.fingerprint;
  drawFingerprintChart("chart-analysis-fingerprint", fp.seasonality_profile);
  document.getElementById("analysis-fingerprint-summary").innerHTML = `
    <strong>Historical Fire Fingerprint (${data.calendar.region.name}):</strong><br/>
    • <strong>Peak Season Months:</strong> ${fp.peak_season_months.join(", ")} (concentrating <strong>${fp.peak_season_concentration_pct}%</strong> of historical annual activity).<br/>
    • <strong>Diurnal / Nocturnal Signature:</strong> ${fp.diurnal_signature.day_percentage}% Daytime (D) vs ${fp.diurnal_signature.night_percentage}% Nighttime (N).<br/>
    • <strong>Secular Theil-Sen Trend (2001–2026):</strong> Harmonized Series = <code>${fp.trend_diagnostics.harmonized_theil_sen_slope_per_yr >= 0 ? '+' : ''}${fp.trend_diagnostics.harmonized_theil_sen_slope_per_yr}/yr</code> (vs Unharmonized Biased Sum = <code>+${fp.trend_diagnostics.naive_concat_theil_sen_slope_per_yr}/yr</code>).
  `;

  // 3. Calibration Models Table
  const calTable = document.getElementById("analysis-calibration-table");
  if (calTable) {
    let html = `<thead><tr>
      <th>Month</th><th>Overlap Yrs</th><th>Slope α</th><th>Intercept β</th>
      <th>Raw V/M Ratio</th><th>1km Grid Ratio</th><th>Terra Factor γ</th><th>R²</th><th>95% CI (α)</th>
    </tr></thead><tbody>`;
    (fp.calibration_models || []).forEach((m) => {
      html += `<tr>
        <td><strong>${MONTH_SHORT[m.month - 1]}</strong></td>
        <td>${m.overlap_years_count ?? "15"}</td>
        <td style="color:#34d399;">${Number(m.alpha_slope).toFixed(4)}</td>
        <td>${Number(m.beta_intercept ?? 0).toFixed(1)}</td>
        <td style="color:#fb923c;">${Number(m.viirs_to_modis_raw_ratio).toFixed(2)}×</td>
        <td>${Number(m.viirs_grid_to_modis_ratio).toFixed(2)}×</td>
        <td>${Number(m.terra_only_adjustment ?? 1).toFixed(2)}×</td>
        <td style="color:#38bdf8;">${Number(m.r_squared).toFixed(3)}</td>
        <td>${m.ci95_low !== undefined ? `[${Number(m.ci95_low).toFixed(3)}, ${Number(m.ci95_high).toFixed(3)}]` : "Global Mean"}</td>
      </tr>`;
    });
    html += `</tbody>`;
    calTable.innerHTML = html;
  }

  // 4. Top Historical Anomalies Table
  const anomTable = document.getElementById("analysis-anomalies-table");
  if (anomTable) {
    let html = `<thead><tr>
      <th>Period</th><th>Activity</th><th>Month Median</th><th>% Anomaly</th><th>Percentile</th><th>Classification</th>
    </tr></thead><tbody>`;
    (data.calendar.top_anomalies || []).forEach((a) => {
      html += `<tr>
        <td><strong>${a.month_short} ${a.year}</strong></td>
        <td>${formatNum(a.value)}</td>
        <td>${formatNum(a.month_median)}</td>
        <td style="color:#fb923c;">+${a.pct_anomaly}%</td>
        <td>P${a.percentile}</td>
        <td><span class="anomaly-badge anom-sev-${a.anomaly_severity}">${a.anomaly_label}</span></td>
      </tr>`;
    });
    html += `</tbody>`;
    anomTable.innerHTML = html;
  }
}

/* ==========================================================================
   7. REGIONAL COMPARISON VIEW
   ========================================================================== */

async function loadAndRenderRegionalComparison() {
  const qs = new URLSearchParams({
    region_a: GFIState.compRegionA,
    region_b: GFIState.compRegionB,
    metric_mode: GFIState.metricMode,
  });
  let data;
  try {
    const res = await apiFetch(`/api/regional-comparison?${qs.toString()}`);
    if (!res.ok) return;
    data = await res.json();
  } catch (_) {
    return;
  }

  drawRegionalSeasonalityComparison("chart-comp-seasonality", data.region_a, data.region_b);
  drawRegionalAnnualComparison("chart-comp-annual", data.region_a, data.region_b);

  const tbl = document.getElementById("comp-summary-table");
  if (tbl) {
    const ra = data.region_a;
    const rb = data.region_b;
    const renderRow = (r) => {
      const reg = r.calendar.region;
      const fp = r.fingerprint;
      const d = r.calendar.trend_diagnostics;
      const topAnom = (r.calendar.top_anomalies || [])[0];
      return `<tr>
        <td><strong>${reg.name}</strong> [<code>${reg.region_code}</code>]</td>
        <td>${reg.biome}</td>
        <td style="color:var(--accent-cyan);">${reg.peak_season_months} (${fp.peak_season_concentration_pct}%)</td>
        <td>${fp.diurnal_signature.day_percentage}% Day / ${fp.diurnal_signature.night_percentage}% Night</td>
        <td>${d.harmonized_theil_sen_slope_per_yr >= 0 ? '+' : ''}${d.harmonized_theil_sen_slope_per_yr}/yr</td>
        <td style="color:#fb923c;">${topAnom ? `${topAnom.month_short} ${topAnom.year} (+${topAnom.pct_anomaly}%)` : '—'}</td>
      </tr>`;
    };
    tbl.innerHTML = `
      <thead><tr>
        <th>Region</th><th>Biome / Ecosystem</th><th>Peak Fire Season</th>
        <th>Diurnal Cycle</th><th>Harmonized Trend (2001–2026)</th><th>Largest Historical Anomaly</th>
      </tr></thead>
      <tbody>${renderRow(ra)}${renderRow(rb)}</tbody>
    `;
  }
}

/* ==========================================================================
   8. DATA EXPLORER, EXPORTS & LIVE FIRMS CSV INGESTION
   ========================================================================== */

function downloadTextBlob(filename, mime, content) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportOfflineHotspotsCsv() {
  const rows = GFIState.hotspotsData?.hotspots || [];
  const header = "latitude,longitude,acq_date,acq_time,instrument,satellite,confidence_tier,frp,brightness_mir,brightness_tir,daynight,region_code";
  const body = rows.map((h) => [
    h.latitude, h.longitude, h.acq_date, h.acq_time, h.instrument, h.satellite,
    h.confidence_tier, h.frp, h.brightness_mir, h.brightness_tir, h.daynight, h.region_code,
  ].join(","));
  downloadTextBlob(`choki_hotspots_${GFIState.regionCode}_offline.csv`, "text/csv;charset=utf-8", [header, ...body].join("\n"));
}

function exportOfflineHotspotsGeoJson() {
  const fc = hotspotsToGeoJSON(GFIState.hotspotsData?.hotspots || []);
  downloadTextBlob(`choki_hotspots_${GFIState.regionCode}_offline.geojson`, "application/geo+json;charset=utf-8", JSON.stringify(fc, null, 2));
}

/* ==========================================================================
   9. SCIENTIFIC HTML5 CANVAS CHART ENGINE
   ========================================================================== */

function prepareChartCanvas(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  canvas.width = rect.width;
  canvas.height = rect.height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  return { canvas, ctx, w: canvas.width, h: canvas.height };
}

function drawSameMonthBarChart(canvasId, series, medianVal, p90Val) {
  const env = prepareChartCanvas(canvasId);
  if (!env || !series || series.length === 0) return;
  const { ctx, w, h } = env;

  const pad = { top: 24, right: 20, bottom: 32, left: 54 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  const vals = series.map((s) => s.value || 0);
  const maxVal = Math.max(...vals, p90Val || 1, 10) * 1.12;

  // Horizontal grid lines
  ctx.strokeStyle = "rgba(148, 163, 184, 0.12)";
  ctx.fillStyle = "#94a3b8";
  ctx.font = "10.5px monospace";
  for (let i = 0; i <= 4; i++) {
    const v = (maxVal * i) / 4;
    const y = pad.top + plotH - (v / maxVal) * plotH;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
    ctx.fillText(String(Math.round(v)), 6, y + 3);
  }

  const barStep = plotW / series.length;
  const barW = Math.max(6, barStep * 0.68);

  series.forEach((item, idx) => {
    const val = item.value || 0;
    const bh = (val / maxVal) * plotH;
    const x = pad.left + idx * barStep + (barStep - barW) * 0.5;
    const y = pad.top + plotH - bh;

    if (item.is_selected) {
      ctx.fillStyle = "#00bfff";
    } else if (val >= p90Val) {
      ctx.fillStyle = "#ea580c";
    } else if (val >= medianVal) {
      ctx.fillStyle = "#d97706";
    } else {
      ctx.fillStyle = "#2a6f97";
    }
    ctx.fillRect(x, y, barW, bh);

    if (idx % 2 === 0 || item.is_selected) {
      ctx.fillStyle = item.is_selected ? "#00bfff" : "#94a3b8";
      ctx.font = item.is_selected ? "bold 10px monospace" : "10px monospace";
      ctx.fillText(String(item.year).slice(-2), x + 1, h - 10);
    }
  });

  // Median Line
  const yMed = pad.top + plotH - (medianVal / maxVal) * plotH;
  ctx.strokeStyle = "#10b981";
  ctx.lineWidth = 1.6;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(pad.left, yMed);
  ctx.lineTo(w - pad.right, yMed);
  ctx.stroke();
  ctx.fillStyle = "#10b981";
  ctx.fillText(`Median: ${Math.round(medianVal)}`, pad.left + 8, yMed - 5);

  // P90 Line
  const yP90 = pad.top + plotH - (p90Val / maxVal) * plotH;
  ctx.strokeStyle = "#f43f5e";
  ctx.beginPath();
  ctx.moveTo(pad.left, yP90);
  ctx.lineTo(w - pad.right, yP90);
  ctx.stroke();
  ctx.fillStyle = "#f43f5e";
  ctx.fillText(`P90: ${Math.round(p90Val)}`, w - pad.right - 95, yP90 - 5);
  ctx.setLineDash([]);
}

function drawHarmonizationProofChart(canvasId, annualList) {
  const env = prepareChartCanvas(canvasId);
  if (!env || !annualList || annualList.length === 0) return;
  const { ctx, w, h } = env;

  const pad = { top: 26, right: 24, bottom: 30, left: 60 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  const concatVals = annualList.map((a) => a.annual_raw_concat);
  const harmVals = annualList.map((a) => a.annual_harmonized_cal);
  const modisVals = annualList.map((a) => a.annual_raw_modis);
  const maxVal = Math.max(...concatVals, ...harmVals, 10) * 1.1;

  // Grid
  ctx.strokeStyle = "rgba(148, 163, 184, 0.12)";
  ctx.fillStyle = "#94a3b8";
  ctx.font = "10px monospace";
  for (let i = 0; i <= 4; i++) {
    const v = (maxVal * i) / 4;
    const y = pad.top + plotH - (v / maxVal) * plotH;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
    ctx.fillText(String(Math.round(v)), 6, y + 3);
  }

  const xOf = (idx) => pad.left + (idx / Math.max(annualList.length - 1, 1)) * plotW;
  const yOf = (val) => pad.top + plotH - (val / maxVal) * plotH;

  // Vertical Sensor Milestone Markers (2012 SNPP, 2018 NOAA-20, 2024 NOAA-21)
  [
    { yr: 2012, lbl: "2012: VIIRS Suomi-NPP Entry" },
    { yr: 2018, lbl: "2018: VIIRS NOAA-20 Entry" },
    { yr: 2024, lbl: "2024: VIIRS NOAA-21 Entry" },
  ].forEach((ms) => {
    const idx = annualList.findIndex((a) => a.year === ms.yr);
    if (idx >= 0) {
      const mx = xOf(idx);
      ctx.strokeStyle = "rgba(249, 115, 22, 0.35)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(mx, pad.top);
      ctx.lineTo(mx, pad.top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#fdba74";
      const lblW = ctx.measureText(ms.lbl).width;
      if (mx + 4 + lblW > w - 6) {
        ctx.textAlign = "right";
        ctx.fillText(ms.lbl, mx - 4, pad.top + 24);
        ctx.textAlign = "left";
      } else {
        ctx.fillText(ms.lbl, mx + 4, pad.top + 12);
      }
    }
  });

  const drawCurve = (arr, color, width, dashed = false) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    if (dashed) ctx.setLineDash([5, 4]);
    ctx.beginPath();
    arr.forEach((v, i) => {
      const sx = xOf(i);
      const sy = yOf(v);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  };

  drawCurve(concatVals, "#f43f5e", 2.0, true); // Unharmonized raw sum
  drawCurve(modisVals, "#38bdf8", 1.8, false); // Raw MODIS
  drawCurve(harmVals, "#10b981", 2.8, false);  // Harmonized H_cal

  annualList.forEach((a, i) => {
    if (i % 2 === 0 || i === annualList.length - 1) {
      ctx.fillStyle = "#94a3b8";
      ctx.fillText(String(a.year), xOf(i) - 12, h - 8);
    }
  });

  // Legend
  ctx.fillStyle = "#10b981";
  ctx.fillText("━━ Calibrated Harmonized Series (H_cal)", pad.left + 10, pad.top - 8);
  ctx.fillStyle = "#38bdf8";
  ctx.fillText("━━ Raw MODIS (1km)", pad.left + 280, pad.top - 8);
  ctx.fillStyle = "#f43f5e";
  ctx.fillText("┅┅ Unharmonized Sum (MODIS+VIIRS)", pad.left + 440, pad.top - 8);
}

function drawYearVsYearChart(canvasId, rowA, rowB, baselines) {
  const env = prepareChartCanvas(canvasId);
  if (!env || !rowA || !rowB) return;
  const { ctx, w, h } = env;

  const pad = { top: 26, right: 20, bottom: 30, left: 50 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  const valsA = MONTH_SHORT.map((_, i) => rowA.months[i + 1]?.value || 0);
  const valsB = MONTH_SHORT.map((_, i) => rowB.months[i + 1]?.value || 0);
  const medVals = baselines.map((b) => b.median);
  const maxVal = Math.max(...valsA, ...valsB, ...medVals, 10) * 1.15;

  const xOf = (i) => pad.left + (i / 11) * plotW;
  const yOf = (v) => pad.top + plotH - (v / maxVal) * plotH;

  ctx.strokeStyle = "rgba(148, 163, 184, 0.12)";
  ctx.fillStyle = "#94a3b8";
  ctx.font = "10px monospace";
  for (let i = 0; i <= 4; i++) {
    const v = (maxVal * i) / 4;
    const y = yOf(v);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
    ctx.fillText(String(Math.round(v)), 6, y + 3);
  }

  const plotLine = (arr, color, lw, dashed = false) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    if (dashed) ctx.setLineDash([4, 4]);
    ctx.beginPath();
    arr.forEach((v, i) => {
      if (i === 0) ctx.moveTo(xOf(i), yOf(v));
      else ctx.lineTo(xOf(i), yOf(v));
    });
    ctx.stroke();
    ctx.setLineDash([]);
  };

  plotLine(medVals, "#94a3b8", 1.6, true);
  plotLine(valsB, "#f97316", 2.2, false);
  plotLine(valsA, "#00bfff", 2.6, false);

  MONTH_SHORT.forEach((m, i) => {
    ctx.fillStyle = "#94a3b8";
    ctx.fillText(m, xOf(i) - 10, h - 8);
  });

  ctx.fillStyle = "#00bfff";
  ctx.fillText(`━━ Year ${rowA.year}`, pad.left + 8, pad.top - 8);
  ctx.fillStyle = "#f97316";
  ctx.fillText(`━━ Year ${rowB.year}`, pad.left + 110, pad.top - 8);
  ctx.fillStyle = "#94a3b8";
  ctx.fillText(`┅┅ Historical Median`, pad.left + 210, pad.top - 8);
}

function drawFingerprintChart(canvasId, profile) {
  const env = prepareChartCanvas(canvasId);
  if (!env || !profile) return;
  const { ctx, w, h } = env;

  const pad = { top: 24, right: 20, bottom: 30, left: 48 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  const shares = profile.map((p) => p.share_of_annual_pct);
  const maxS = Math.max(...shares, 15) * 1.15;
  const barStep = plotW / 12;
  const barW = barStep * 0.64;

  shares.forEach((s, i) => {
    const bh = (s / maxS) * plotH;
    const x = pad.left + i * barStep + (barStep - barW) * 0.5;
    const y = pad.top + plotH - bh;
    ctx.fillStyle = profile[i].is_peak_season ? "#ea580c" : "#2a6f97";
    ctx.fillRect(x, y, barW, bh);

    ctx.fillStyle = "#e2e8f0";
    ctx.font = "10px monospace";
    ctx.fillText(`${s.toFixed(1)}%`, x, y - 4);
    ctx.fillStyle = "#94a3b8";
    ctx.fillText(MONTH_SHORT[i], x + 2, h - 8);
  });
}

function drawRegionalSeasonalityComparison(canvasId, regA, regB) {
  const env = prepareChartCanvas(canvasId);
  if (!env || !regA || !regB) return;
  const { ctx, w, h } = env;
  const pad = { top: 26, right: 20, bottom: 30, left: 48 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  const sA = regA.fingerprint.seasonality_profile.map((p) => p.share_of_annual_pct);
  const sB = regB.fingerprint.seasonality_profile.map((p) => p.share_of_annual_pct);
  const maxVal = Math.max(...sA, ...sB, 20) * 1.12;

  const xOf = (i) => pad.left + (i / 11) * plotW;
  const yOf = (v) => pad.top + plotH - (v / maxVal) * plotH;

  const drawLine = (arr, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    arr.forEach((v, i) => {
      if (i === 0) ctx.moveTo(xOf(i), yOf(v));
      else ctx.lineTo(xOf(i), yOf(v));
    });
    ctx.stroke();
  };

  drawLine(sA, "#00bfff");
  drawLine(sB, "#f97316");

  MONTH_SHORT.forEach((m, i) => {
    ctx.fillStyle = "#94a3b8";
    ctx.font = "10px monospace";
    ctx.fillText(m, xOf(i) - 10, h - 8);
  });

  ctx.fillStyle = "#00bfff";
  ctx.fillText(`━━ ${regA.calendar.region.region_code}`, pad.left + 10, pad.top - 8);
  ctx.fillStyle = "#f97316";
  ctx.fillText(`━━ ${regB.calendar.region.region_code}`, pad.left + 120, pad.top - 8);
}

function drawRegionalAnnualComparison(canvasId, regA, regB) {
  const env = prepareChartCanvas(canvasId);
  if (!env || !regA || !regB) return;
  const { ctx, w, h } = env;
  const pad = { top: 26, right: 20, bottom: 30, left: 54 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  const yrsA = regA.calendar.calendar_years;
  const yrsB = regB.calendar.calendar_years;
  const vA = yrsA.map((y) => y.annual_harmonized_cal);
  const vB = yrsB.map((y) => y.annual_harmonized_cal);
  const maxVal = Math.max(...vA, ...vB, 100) * 1.1;

  const xOf = (i) => pad.left + (i / Math.max(yrsA.length - 1, 1)) * plotW;
  const yOf = (v) => pad.top + plotH - (v / maxVal) * plotH;

  const drawLine = (arr, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.3;
    ctx.beginPath();
    arr.forEach((v, i) => {
      if (i === 0) ctx.moveTo(xOf(i), yOf(v));
      else ctx.lineTo(xOf(i), yOf(v));
    });
    ctx.stroke();
  };

  drawLine(vA, "#00bfff");
  drawLine(vB, "#f97316");

  yrsA.forEach((y, i) => {
    if (i % 4 === 0 || i === yrsA.length - 1) {
      ctx.fillStyle = "#94a3b8";
      ctx.font = "10px monospace";
      ctx.fillText(String(y.year), xOf(i) - 12, h - 8);
    }
  });
}

/* ==========================================================================
   9B. SILENT BACKGROUND QC, VALIDATION PROOF & 15-MIN SWATH WATCHDOG
   ========================================================================== */

const WATCHDOG_INTERVAL_MS = 15 * 60 * 1000; // 15 min aligned with NASA polar NRT latency & 5,000 tx / 10-min limit
let swathWatchdogTimer = null;
let countdownTimer = null;
let nextWatchdogEpoch = null;
let monitoredUserCoords = null; // { lat, lon, sourceLabel }

let alertFocusCoords = null; // { lat, lon }

function closeProximityModal() {
  const modal = document.getElementById("proximity-alert-modal");
  if (modal) modal.style.display = "none";
}

const ALERT_PREFS_KEY = "choki_alert_prefs_v1";
let alertUserPrefs = {
  radiusKm: 120,
  minFrp: 15,
  modal: true,
  desktop: false,
  sound: false,
  aiStrict: true,
  address: "",
  contact: "",
};

function loadAlertUserPrefs() {
  try {
    const raw = localStorage.getItem(ALERT_PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      alertUserPrefs = { ...alertUserPrefs, ...parsed };
    }
  } catch (_) {}
  return alertUserPrefs;
}

function saveAlertUserPrefs() {
  try {
    localStorage.setItem(ALERT_PREFS_KEY, JSON.stringify(alertUserPrefs));
  } catch (_) {}
}

function playAlertWarningChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    [587.33, 880.0].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, now + i * 0.14);
      gain.gain.setValueAtTime(0.14, now + i * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.14 + 0.24);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.14);
      osc.stop(now + i * 0.14 + 0.25);
    });
  } catch (_) {}
}

function bindWatchdogControls() {
  loadAlertUserPrefs();

  document.getElementById("btn-monitor-my-area")?.addEventListener("click", () => {
    locateAndMonitorUserArea(true);
  });
  document.getElementById("btn-dismiss-proximity-toast")?.addEventListener("click", closeProximityModal);
  document.getElementById("btn-acknowledge-proximity")?.addEventListener("click", closeProximityModal);
  document.getElementById("proximity-alert-modal")?.addEventListener("click", (e) => {
    if (e.target?.id === "proximity-alert-modal") closeProximityModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeProximityModal();
  });
  document.getElementById("btn-alert-center-fire")?.addEventListener("click", () => {
    const target = alertFocusCoords || monitoredUserCoords;
    closeProximityModal();
    if (target && GFIState.map.mainInstance) {
      GFIState.map.mainInstance.flyTo({
        center: [target.lon, target.lat],
        zoom: 7.4,
        pitch: 28,
        duration: 1100,
        essential: true,
      });
      setTimeout(() => {
        GFIState.map.inspectZoneAtCoords?.(target.lat, target.lon, 25);
      }, 450);
    }
  });
  document.getElementById("btn-alert-inspect-qc")?.addEventListener("click", () => {
    closeProximityModal();
    switchView("validation-proof");
  });

  // Configurable Fire Alerts Modal
  const alertsModal = document.getElementById("fire-alerts-config-modal");
  const radiusInput = document.getElementById("alert-cfg-radius");
  const radiusValEl = document.getElementById("alert-cfg-radius-val");
  const frpInput = document.getElementById("alert-cfg-min-frp");
  const frpValEl = document.getElementById("alert-cfg-frp-val");
  const addrInput = document.getElementById("alert-cfg-address");
  const contactInput = document.getElementById("alert-cfg-contact");
  const chkModal = document.getElementById("alert-chk-modal");
  const chkDesktop = document.getElementById("alert-chk-desktop");
  const chkSound = document.getElementById("alert-chk-sound");
  const chkAi = document.getElementById("alert-chk-ai-strict");

  const refreshAlertPresetHighlight = () => {
    const radVal = parseInt(radiusInput?.value || "120", 10);
    const frpVal = parseInt(frpInput?.value || "15", 10);
    document.querySelectorAll('.alerts-preset-row[data-preset-group="radius"] .alerts-preset-chip').forEach((btn) => {
      btn.classList.toggle("is-active", parseInt(btn.getAttribute("data-val"), 10) === radVal);
    });
    document.querySelectorAll('.alerts-preset-row[data-preset-group="frp"] .alerts-preset-chip').forEach((btn) => {
      btn.classList.toggle("is-active", parseInt(btn.getAttribute("data-val"), 10) === frpVal);
    });
  };

  const setAlertRadiusVal = (v) => {
    const clamped = Math.min(250, Math.max(15, Math.round(v / 5) * 5));
    if (radiusInput) radiusInput.value = String(clamped);
    if (radiusValEl) radiusValEl.textContent = `${clamped} km`;
    refreshAlertPresetHighlight();
  };

  const setAlertFrpVal = (v) => {
    const clamped = Math.min(150, Math.max(0, Math.round(v / 5) * 5));
    if (frpInput) frpInput.value = String(clamped);
    if (frpValEl) frpValEl.textContent = `${clamped} MW`;
    refreshAlertPresetHighlight();
  };

  const syncAlertModalInputs = () => {
    loadAlertUserPrefs();
    setAlertRadiusVal(alertUserPrefs.radiusKm || 120);
    setAlertFrpVal(alertUserPrefs.minFrp ?? 15);
    if (chkModal) chkModal.checked = alertUserPrefs.modal !== false;
    if (chkDesktop) chkDesktop.checked = Boolean(alertUserPrefs.desktop);
    if (chkSound) chkSound.checked = Boolean(alertUserPrefs.sound);
    if (chkAi) chkAi.checked = alertUserPrefs.aiStrict !== false;
  };

  document.getElementById("btn-open-alerts-config")?.addEventListener("click", () => {
    syncAlertModalInputs();
    if (alertsModal) alertsModal.style.display = "flex";
  });
  document.getElementById("btn-close-alerts-config")?.addEventListener("click", () => {
    if (alertsModal) alertsModal.style.display = "none";
  });
  alertsModal?.addEventListener("click", (e) => {
    if (e.target === alertsModal) alertsModal.style.display = "none";
  });

  document.querySelectorAll('.alerts-preset-row[data-preset-group="radius"] .alerts-preset-chip').forEach((btn) => {
    btn.addEventListener("click", () => setAlertRadiusVal(parseInt(btn.getAttribute("data-val"), 10)));
  });
  document.querySelectorAll('.alerts-preset-row[data-preset-group="frp"] .alerts-preset-chip').forEach((btn) => {
    btn.addEventListener("click", () => setAlertFrpVal(parseInt(btn.getAttribute("data-val"), 10)));
  });
  document.querySelectorAll(".alerts-step-btn[data-step-target]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-step-target");
      const delta = parseInt(btn.getAttribute("data-step-delta"), 10) || 0;
      if (target === "radius") {
        setAlertRadiusVal((parseInt(radiusInput?.value || "120", 10) || 120) + delta);
      } else if (target === "frp") {
        setAlertFrpVal((parseInt(frpInput?.value || "15", 10) || 0) + delta);
      }
    });
  });

  const collectAlertPrefsFromForm = async () => {
    alertUserPrefs.radiusKm = parseInt(radiusInput?.value || "120", 10) || 120;
    alertUserPrefs.minFrp = parseInt(frpInput?.value || "15", 10) || 0;
    alertUserPrefs.modal = chkModal ? chkModal.checked : true;
    alertUserPrefs.desktop = chkDesktop ? chkDesktop.checked : false;
    alertUserPrefs.sound = chkSound ? chkSound.checked : false;
    alertUserPrefs.aiStrict = chkAi ? chkAi.checked : true;
    alertUserPrefs.address = (addrInput?.value || "").trim();
    alertUserPrefs.contact = (contactInput?.value || "").trim();
    saveAlertUserPrefs();

    if (alertUserPrefs.desktop && "Notification" in window && Notification.permission === "default") {
      try {
        await Notification.requestPermission();
      } catch (_) {}
    }

    const q = alertUserPrefs.address;
    if (q) {
      const coordMatch = q.match(/(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)/);
      if (coordMatch) {
        const lat = parseFloat(coordMatch[1]);
        const lon = parseFloat(coordMatch[2]);
        if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
          setCustomMonitorLocation(lat, lon, q);
        }
      } else if (navigator.onLine) {
        try {
          const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, {
            headers: { Accept: "application/json" },
          });
          if (res.ok) {
            const rows = await res.json();
            if (Array.isArray(rows) && rows.length > 0) {
              const r = rows[0];
              const name = r.display_name.split(",").slice(0, 2).join(", ");
              setCustomMonitorLocation(parseFloat(r.lat), parseFloat(r.lon), name);
            }
          }
        } catch (_) {}
      }
    }
  };

  document.getElementById("btn-save-alert-cfg")?.addEventListener("click", async () => {
    await collectAlertPrefsFromForm();
    if (alertsModal) alertsModal.style.display = "none";
    await runSwathWatchdogCycle(true);
  });

  document.getElementById("btn-test-fire-alert")?.addEventListener("click", async () => {
    await collectAlertPrefsFromForm();
    if (alertsModal) alertsModal.style.display = "none";
    const locName = monitoredUserCoords?.sourceLabel || alertUserPrefs.address || "Chihuahua, Mexico";
    const lat = monitoredUserCoords?.lat ?? 28.633;
    const lon = monitoredUserCoords?.lon ?? -106.069;
    showProximityToast(
      `Active Wildfire Threat — ${locName}`,
      `NASA FIRMS orbital check verified <strong>14</strong> active biomass fire pixels within your configured <strong>${alertUserPrefs.radiusKm} km</strong> alert perimeter (${lat.toFixed(2)}°, ${lon.toFixed(2)}°).`,
      true,
      {
        nearestKm: 6.4,
        activeCount: 14,
        maxFrp: Math.max(84.5, alertUserPrefs.minFrp || 15),
        focusCoords: { lat, lon },
      }
    );
  });
}

function computeOfflineDualAiAnalysis(records) {
  const sample = (records || []).slice(0, 80);
  const counts = {
    ACTIVE_BIOMASS_FIRE: 0,
    PERSISTENT_INDUSTRIAL_FLARE: 0,
    CLOUD_EDGE_OR_CONTAMINATED: 0,
    SUNGLINT_OR_WARM_SOIL_NOISE: 0,
    AMBIGUOUS_THERMAL_ANOMALY: 0,
  };
  let sumIa1 = 0;
  let sumIa2 = 0;
  let sumCloudRisk = 0;
  let agreed = 0;
  let cloudBlocked = 0;
  let hScoreSum = 0;

  for (const r of sample) {
    const mir = Number(r.bright_mir) || 308;
    const tir = Number(r.bright_tir) || 288;
    const dt = mir - tir;
    const frp = Math.max(0.1, Number(r.frp) || 1.5);
    const conf = Number(r.confidence_norm ?? (r.confidence_raw === "h" ? 0.9 : r.confidence_raw === "n" ? 0.6 : 0.35));
    const isNight = String(r.daynight || "N").toUpperCase() === "N";
    const typeCode = Number(r.type || 0);
    const cloudFrac = Number(r.cloud_fraction ?? 0);

    // Cloud-edge / solar glint risk heuristic matching server physical spectral gates
    const coldCloudTop = tir < 273.5 && !isNight;
    const cloudRisk = Math.min(
      0.98,
      Math.max(0, cloudFrac * 0.85 + (coldCloudTop ? 0.42 : 0) + (!isNight && dt < 16 ? 0.28 : 0))
    );
    sumCloudRisk += cloudRisk;

    // IA-1: Spectral MIR-TIR & log-FRP discriminator
    const z1 = -0.6 + 0.12 * (dt - 14) + 0.65 * Math.log1p(frp) + 0.9 * conf - 2.4 * cloudRisk;
    const p1 = 1 / (1 + Math.exp(-Math.max(-12, Math.min(12, z1))));

    // IA-2: Independent Daytime Glint + Nighttime Thermal Verifier
    const nightBonus = isNight ? 0.95 : -0.15;
    const z2 = -0.2 + 0.14 * (dt - 12) + 0.52 * Math.log1p(frp) + nightBonus + 0.7 * conf - 2.6 * cloudRisk;
    const p2 = 1 / (1 + Math.exp(-Math.max(-12, Math.min(12, z2))));

    sumIa1 += p1;
    sumIa2 += p2;

    const c1 = typeCode === 2 ? "PERSISTENT_INDUSTRIAL_FLARE" : cloudRisk >= 0.45 ? "CLOUD_EDGE_OR_CONTAMINATED" : p1 >= 0.5 ? "ACTIVE_BIOMASS_FIRE" : "AMBIGUOUS_THERMAL_ANOMALY";
    const c2 = typeCode === 2 ? "PERSISTENT_INDUSTRIAL_FLARE" : cloudRisk >= 0.45 ? "CLOUD_EDGE_OR_CONTAMINATED" : p2 >= 0.5 ? "ACTIVE_BIOMASS_FIRE" : "AMBIGUOUS_THERMAL_ANOMALY";
    if (c1 === c2) agreed += 1;

    const finalClass = cloudRisk >= 0.45 ? "CLOUD_EDGE_OR_CONTAMINATED" : (p1 + p2) * 0.5 >= 0.52 ? (typeCode === 2 ? "PERSISTENT_INDUSTRIAL_FLARE" : "ACTIVE_BIOMASS_FIRE") : !isNight && dt < 14 ? "SUNGLINT_OR_WARM_SOIL_NOISE" : "AMBIGUOUS_THERMAL_ANOMALY";
    counts[finalClass] += 1;
    if (finalClass === "CLOUD_EDGE_OR_CONTAMINATED") cloudBlocked += 1;
    hScoreSum += r.instrument === "VIIRS" ? 0.89 : 0.94;
  }

  const n = Math.max(1, sample.length);
  const ia1Pct = Number(((sumIa1 / n) * 100).toFixed(1));
  const ia2Pct = Number(((sumIa2 / n) * 100).toFixed(1));
  const agreePct = Number(((agreed / n) * 100).toFixed(1));

  return {
    zone_screened_count: n,
    zone_classification_counts: counts,
    mean_wildfire_probability_pct: Number((((ia1Pct + ia2Pct) / 2)).toFixed(1)),
    mean_cloud_glint_risk_pct: Number(((sumCloudRisk / n) * 100).toFixed(1)),
    dual_ai_summary: {
      ia1_name: "FireNet Offline Spectral",
      ia2_name: "VerifierNet Local Audit",
      ia1_mean_fire_prob_pct: ia1Pct,
      ia2_mean_fire_prob_pct: ia2Pct,
      consensus_agreement_pct: agreePct,
      cloud_false_positives_blocked: cloudBlocked,
      harmonization_verdict: "LOCAL_OFFLINE_CONSENSUS",
      ia2_harmonization_score_pct: Number(((hScoreSum / n) * 100).toFixed(1)),
    },
  };
}

async function runSilentZoneQc(records) {
  const slot = document.getElementById("auto-qc-strip-slot");
  if (!slot || !Array.isArray(records) || records.length === 0) return;

  if (window.ChokiReactUI?.renderDualAiQcCard) {
    window.ChokiReactUI.renderDualAiQcCard(slot, null, { loading: true });
  }

  try {
    const res = await apiFetch("/api/ai/analyze", {
      method: "POST",
      body: JSON.stringify({
        region_code: GFIState.regionCode,
        records: records.slice(0, 80),
        question: "Automated Dual-AI cloud & false-positive screening.",
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const out = await res.json();

    if (window.ChokiReactUI?.renderDualAiQcCard) {
      window.ChokiReactUI.renderDualAiQcCard(slot, out);
      return;
    }

    const zc = out.zone_classification_counts || {};
    const active = zc.ACTIVE_BIOMASS_FIRE ?? 0;
    const clouds = zc.CLOUD_EDGE_OR_CONTAMINATED ?? 0;
    const flares = zc.PERSISTENT_INDUSTRIAL_FLARE ?? 0;
    const noise = zc.SUNGLINT_OR_WARM_SOIL_NOISE ?? 0;
    const cloudRisk = out.mean_cloud_glint_risk_pct ?? 0;
    const flagged = clouds + flares + noise;

    slot.innerHTML = `
      <div class="qc-auto-strip ${flagged > active ? "warn" : ""}">
        <div class="qc-auto-strip-header">
          <span>✓ Fire Verification</span>
          <span class="provenance-pill ${flagged > 0 ? "pill-harmonized" : "pill-observed"}">${out.mean_wildfire_probability_pct ?? 0}% Fire Confidence</span>
        </div>
        <div style="font-size:10.5px; color:#cbd5e1;">
          ${out.zone_screened_count ?? records.length} px screened • Cloud/Glint Risk ${cloudRisk}%
        </div>
        <div class="qc-auto-metrics">
          <div class="qc-mini-stat"><span class="qc-mini-val" style="color:#10b981;">${active}</span><span class="qc-mini-lbl">Active Fire</span></div>
          <div class="qc-mini-stat"><span class="qc-mini-val" style="color:#38bdf8;">${clouds}</span><span class="qc-mini-lbl">Cloud Veto</span></div>
          <div class="qc-mini-stat"><span class="qc-mini-val" style="color:#f59e0b;">${flares}</span><span class="qc-mini-lbl">Static Flare</span></div>
          <div class="qc-mini-stat"><span class="qc-mini-val" style="color:#f43f5e;">${noise}</span><span class="qc-mini-lbl">Glint Noise</span></div>
        </div>
      </div>
    `;
  } catch (_) {
    // True offline Dual-AI screening fallback (never blocks inspector on network loss)
    const localOut = computeOfflineDualAiAnalysis(records);
    if (window.ChokiReactUI?.renderDualAiQcCard) {
      window.ChokiReactUI.renderDualAiQcCard(slot, localOut);
    }
  }
}

async function loadAndRenderValidationProof(zoneRecords = null) {
  const scorecardEl = document.getElementById("ai-proof-scorecard-grid");
  const breakdownEl = document.getElementById("ai-screening-breakdown");
  const predTableEl = document.getElementById("ai-predictions-table");
  const chatBoxEl = document.getElementById("ai-chat-response-box");
  const tsBadge = document.getElementById("qc-audit-timestamp");

  try {
    let out = null;
    try {
      const res = await apiFetch("/api/ai/analyze", {
        method: "POST",
        body: JSON.stringify({
          region_code: GFIState.regionCode,
          records: zoneRecords && zoneRecords.length ? zoneRecords.slice(0, 80) : null,
          question: "Summarize harmonization metrics and false-positive screening.",
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      out = await res.json();
      if (!zoneRecords) OfflineCache.set("qc_proof_latest_v1", out).catch(() => {});
    } catch (_) {
      const cached = await OfflineCache.get("qc_proof_latest_v1");
      if (cached?.data) {
        out = cached.data;
      } else {
        out = computeOfflineDualAiAnalysis(zoneRecords || GFIState.hotspotsData?.hotspots || []);
      }
    }
    if (!out) return;
    const audit = out.audit || {};
    const hp = audit.harmonization_proof || {};
    const dp = audit.colocation_dedup_proof || {};

    if (tsBadge) {
      tsBadge.textContent = `VERIFIED AT ${new Date().toISOString().slice(11, 16)} UTC`;
    }

    if (scorecardEl) {
      scorecardEl.innerHTML = `
        <div class="sci-panel" style="padding:10px; gap:4px; border-left:3px solid #f43f5e;">
          <span style="font-size:10px; color:var(--text-secondary);">RAW UNHARMONIZED JUMP (2012+)</span>
          <strong style="font-family:var(--font-mono); font-size:20px; color:#f43f5e;">+${hp.naive_concat_jump_2012_pct ?? 0}%</strong>
          <span style="font-size:10.5px; color:var(--text-secondary);">Artificial VIIRS/MODIS discontinuity</span>
        </div>
        <div class="sci-panel" style="padding:10px; gap:4px; border-left:3px solid #10b981;">
          <span style="font-size:10px; color:var(--text-secondary);">HARMONIZED H_cal SHIFT</span>
          <strong style="font-family:var(--font-mono); font-size:20px; color:#10b981;">${hp.harmonized_hcal_shift_pct >= 0 ? "+" : ""}${hp.harmonized_hcal_shift_pct ?? 0}%</strong>
          <span style="font-size:10.5px; color:#34d399;">${hp.bias_reduction_factor ?? 1}× cross-sensor bias removed</span>
        </div>
        <div class="sci-panel" style="padding:10px; gap:4px; border-left:3px solid #38bdf8;">
          <span style="font-size:10px; color:var(--text-secondary);">OVERLAP CALIBRATION R² / α</span>
          <strong style="font-family:var(--font-mono); font-size:20px; color:#38bdf8;">R² = ${hp.calibration_r2_mean ?? 0}</strong>
          <span style="font-size:10.5px; color:var(--text-secondary);">Mean α = ${hp.mean_transfer_slope_alpha ?? 1} | V/M = ${hp.viirs_to_modis_detection_ratio ?? 1}×</span>
        </div>
        <div class="sci-panel" style="padding:10px; gap:4px; border-left:3px solid #c084fc;">
          <span style="font-size:10px; color:var(--text-secondary);">CO-LOCATION DEDUPLICATION</span>
          <strong style="font-family:var(--font-mono); font-size:20px; color:#c084fc;">${formatInt(dp.total_thermal_events)}</strong>
          <span style="font-size:10.5px; color:var(--text-secondary);">${formatInt(dp.dual_sensor_confirmed_events)} Dual MODIS+VIIRS confirmed</span>
        </div>
      `;
    }

    if (window.ChokiReactUI?.renderValidationProof && (breakdownEl || predTableEl)) {
      window.ChokiReactUI.renderValidationProof(breakdownEl, predTableEl, out);
    } else {
      if (breakdownEl) {
        const zc = out.zone_classification_counts || {};
        breakdownEl.innerHTML = `
          <div class="sci-callout" style="margin-bottom:8px;">
            <strong>Automated Batch Audit (${out.zone_screened_count} pixels • Mean Fire Confidence ${out.mean_wildfire_probability_pct}%):</strong><br/>
            • <span style="color:#10b981;">Active Biomass Fire:</span> <strong>${zc.ACTIVE_BIOMASS_FIRE ?? 0}</strong> |
              <span style="color:#38bdf8;">Cloud-Edge FP:</span> <strong>${zc.CLOUD_EDGE_OR_CONTAMINATED ?? 0}</strong> |
              <span style="color:#f59e0b;">Persistent Flare:</span> <strong>${zc.PERSISTENT_INDUSTRIAL_FLARE ?? 0}</strong> |
              <span style="color:#f43f5e;">Sunglint Noise:</span> <strong>${zc.SUNGLINT_OR_WARM_SOIL_NOISE ?? 0}</strong>
          </div>
        `;
      }
      if (predTableEl) {
        const preds = out.sample_predictions || [];
        let html = `<thead><tr><th>Hotspot</th><th>QC Class</th><th>Score</th><th>ΔT</th><th>Evidence</th></tr></thead><tbody>`;
        preds.forEach((p) => {
          html += `<tr><td>#${p.hotspot_id ?? "—"}</td><td>${escapeHtml(p.classification)}</td><td>${p.wildfire_probability_pct}%</td><td>${p.delta_t_kelvin} K</td><td>${escapeHtml((p.evidence || []).slice(0, 2).join("; "))}</td></tr>`;
        });
        html += `</tbody>`;
        predTableEl.innerHTML = html;
      }
    }

    if (chatBoxEl) {
      chatBoxEl.innerHTML = `
        <strong>Latest Local / Regional Screening Summary:</strong><br/>
        ${out.narrative || "Background quality screening operational."}
      `;
    }
  } catch (err) {
    if (chatBoxEl) chatBoxEl.innerHTML = `✖ Verification service error: ${err.message}`;
  }
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function showProximityToast(title, bodyHtml, isCritical = true, stats = null) {
  const modal = document.getElementById("proximity-alert-modal");
  const card = document.getElementById("proximity-modal-card");
  const kicker = document.getElementById("proximity-modal-kicker");
  const emblem = document.getElementById("proximity-alert-emblem");
  const titleEl = document.getElementById("proximity-toast-title");
  const bodyEl = document.getElementById("proximity-toast-body");
  const metricsEl = document.getElementById("proximity-modal-metrics");
  const centerBtn = document.getElementById("btn-alert-center-fire");
  const qcBtn = document.getElementById("btn-alert-inspect-qc");
  const sensorSubDetail = document.getElementById("proximity-sensor-sub-detail");
  if (!modal || !card || !titleEl || !bodyEl) return;

  card.classList.toggle("advisory", !isCritical);
  modal.classList.toggle("advisory-mode", !isCritical);

  if (kicker) {
    kicker.textContent = isCritical ? "CRITICAL THERMAL PROXIMITY" : "LOCAL THERMAL ADVISORY";
  }
  if (sensorSubDetail) {
    sensorSubDetail.textContent = isCritical
      ? "NASA FIRMS • MODIS (1 km) & VIIRS (375 m) Verified"
      : "120 km Radius Orbital Scan Verified";
  }

  if (emblem) {
    emblem.innerHTML = isCritical
      ? `<svg class="danger-core-icon" viewBox="0 0 48 48" width="42" height="42" fill="none">
          <path d="M24 6L44 41H4L24 6Z" fill="rgba(239, 68, 68, 0.18)" stroke="#f87171" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" />
          <line x1="24" y1="18" x2="24" y2="29" stroke="#ffffff" stroke-width="3.6" stroke-linecap="round" />
          <circle cx="24" cy="35.5" r="2.2" fill="#ffffff" />
        </svg>`
      : `<svg class="danger-core-icon" viewBox="0 0 48 48" width="40" height="40" fill="none">
          <circle cx="24" cy="24" r="18" fill="rgba(16, 185, 129, 0.16)" stroke="#34d399" stroke-width="3" />
          <polyline points="16 24.5 22 30.5 33 18.5" stroke="#ffffff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>`;
  }

  titleEl.textContent = title;
  bodyEl.innerHTML = bodyHtml;

  if (metricsEl) {
    if (stats) {
      metricsEl.style.display = "grid";
      metricsEl.innerHTML = `
        <div class="proximity-kpi-chip kpi-danger">
          <span>DISTANCE</span>
          <strong style="color:${stats.nearestKm <= 30 ? "#f87171" : "#fb923c"};">${stats.nearestKm.toFixed(1)} <small>km</small></strong>
        </div>
        <div class="proximity-kpi-chip kpi-cyan">
          <span>ACTIVE FIRES</span>
          <strong style="color:#38bdf8;">${formatInt(stats.activeCount)}</strong>
        </div>
        <div class="proximity-kpi-chip kpi-amber">
          <span>PEAK POWER</span>
          <strong style="color:#fde047;">${stats.maxFrp.toFixed(1)} <small>MW</small></strong>
        </div>
      `;
    } else {
      metricsEl.style.display = "none";
      metricsEl.innerHTML = "";
    }
  }

  alertFocusCoords = stats?.focusCoords || null;
  if (centerBtn) {
    centerBtn.style.display = isCritical && (alertFocusCoords || monitoredUserCoords) ? "inline-flex" : "none";
  }
  if (qcBtn) {
    qcBtn.style.display = isCritical ? "inline-flex" : "none";
  }

  if (isCritical && alertUserPrefs.sound) {
    playAlertWarningChime();
  }
  if (isCritical && alertUserPrefs.desktop && "Notification" in window && Notification.permission === "granted") {
    try {
      new Notification(title, {
        body: bodyEl.textContent || "Active wildfire perimeter detected near your monitored area.",
      });
    } catch (_) {}
  }

  if (alertUserPrefs.modal !== false || !isCritical) {
    modal.style.display = "flex";
  }
}

function locateAndMonitorUserArea(manualTrigger = false) {
  if (!navigator.geolocation) {
    if (manualTrigger) {
      showProximityToast(
        "📍 Geolocation Unavailable",
        "Browser geolocation is unavailable; monitoring currently selected study region center instead.",
        false
      );
    }
    runSwathWatchdogCycle();
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      monitoredUserCoords = {
        lat: Number(pos.coords.latitude.toFixed(4)),
        lon: Number(pos.coords.longitude.toFixed(4)),
        sourceLabel: "Your GPS Location",
      };
      saveUserCoords(monitoredUserCoords);
      syncTopSearchWithLocation();
      flyToUserLocation(1150);
      await runSwathWatchdogCycle(manualTrigger);
    },
    () => {
      if (manualTrigger) {
        showProximityToast(
          "📍 Location Permission Declined",
          "Monitoring current map region center instead. Grant location access anytime to scan within 120 km of your position.",
          false
        );
      }
      runSwathWatchdogCycle(manualTrigger);
    },
    { enableHighAccuracy: false, timeout: 6000, maximumAge: 300000 }
  );
}

async function runSwathWatchdogCycle(showClearAdvisory = false) {
  const dot = document.getElementById("hud-sync-dot");
  const lbl = document.getElementById("hud-sync-label");
  if (!navigator.onLine) {
    updateConnectivityHud(true);
    if (monitoredUserCoords) {
      const cachedLocal = (await OfflineCache.get("hotspots_local_user"))?.data?.hotspots
        || GFIState.hotspotsData?.hotspots || [];
      let nearbyCount = 0;
      let nearestKm = Infinity;
      let maxFrp = 0;
      let nearestRow = null;
      cachedLocal.forEach((r) => {
        const d = haversineKm(monitoredUserCoords.lat, monitoredUserCoords.lon, r.latitude, r.longitude);
        if (d <= 120) {
          nearbyCount += 1;
          if (d < nearestKm) {
            nearestKm = d;
            nearestRow = r;
          }
          if ((r.frp || 0) > maxFrp) maxFrp = r.frp;
        }
      });
      if (nearbyCount > 0) {
        showProximityToast(
          `Active Fire Near Your Area (${monitoredUserCoords.lat.toFixed(2)}°, ${monitoredUserCoords.lon.toFixed(2)}°)`,
          `Offline cache detected <strong>${nearbyCount}</strong> thermal detections within 120 km of your monitored coordinates.`,
          true,
          {
            nearestKm,
            activeCount: nearbyCount,
            maxFrp,
            focusCoords: nearestRow ? { lat: nearestRow.latitude, lon: nearestRow.longitude } : null,
          }
        );
      }
    }
    return;
  }
  if (dot) dot.classList.add("syncing");
  if (lbl) lbl.textContent = "Online";

  try {
    let centerLat = monitoredUserCoords?.lat;
    let centerLon = monitoredUserCoords?.lon;
    let locLabel = monitoredUserCoords?.sourceLabel;

    if (centerLat == null || centerLon == null) {
      const reg = (GFIState.regions || []).find((r) => r.region_code === GFIState.regionCode);
      if (reg) {
        centerLat = (reg.bbox_min_lat + reg.bbox_max_lat) / 2;
        centerLon = (reg.bbox_min_lon + reg.bbox_max_lon) / 2;
        locLabel = reg.name;
      } else {
        centerLat = 28.6;
        centerLon = -106.1;
        locLabel = "Active Map Region";
      }
    }

    const degSpan = Math.max(0.5, (alertUserPrefs.radiusKm || 120) / 111.0);
    const bbox = [
      Number((centerLon - degSpan).toFixed(2)),
      Number((centerLat - degSpan).toFixed(2)),
      Number((centerLon + degSpan).toFixed(2)),
      Number((centerLat + degSpan).toFixed(2)),
    ];
    const configuredKey = document.getElementById("firms-api-key-input")?.value?.trim() || "";
    let ingestedTotal = 0;
    let serverSyncedNew = false;

    // Inspect backend 15-min NRT watchdog health & database count
    let healthData = null;
    try {
      const hRes = await apiFetch("/api/health");
      if (hRes.ok) {
        healthData = await hRes.json();
        const dbCnt = healthData?.database?.raw_hotspots_count;
        if (typeof dbCnt === "number") {
          if (typeof window._lastWatchdogDbCount === "number" && dbCnt > window._lastWatchdogDbCount) {
            serverSyncedNew = true;
          }
          window._lastWatchdogDbCount = dbCnt;
        }
      }
    } catch (_) {}

    const serverHasKey = Boolean(healthData?.firms_api_configured);
    const lastServerNrtEpoch = Number(healthData?.nrt_sync?.last_sync_epoch || 0);
    const serverNeedsTrigger = serverHasKey && (lastServerNrtEpoch === 0 || (Date.now() / 1000 - lastServerNrtEpoch > 930));

    // Trigger global backend NRT sync automatically if stale/pending, or use custom user MAP_KEY
    if (serverNeedsTrigger && !configuredKey) {
      try {
        await apiFetch("/api/nrt/sync", { method: "POST", body: "{}" });
      } catch (_) {}
    } else if (configuredKey) {
      const sources = ["VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT", "MODIS_NRT"];
      const reqBbox = GFIState.regionCode === "ALL" ? [-179.9, -60.0, 179.9, 75.0] : bbox;
      const reqReg = GFIState.regionCode === "ALL" ? "LIVE-WORLD" : GFIState.regionCode;
      for (const src of sources) {
        try {
          const res = await apiFetch("/api/ingest/firms-api", {
            method: "POST",
            body: JSON.stringify({
              map_key: configuredKey,
              source: src,
              bbox: reqBbox,
              day_range: 1,
              region_code: reqReg,
            }),
          });
          if (res.ok) {
            const out = await res.json();
            ingestedTotal += (out.records_inserted ?? out.inserted_hotspots ?? 0);
          }
        } catch (_) {}
      }
    }

    // Evaluate local bounding box directly from in-memory hotspots first (zero extra RAM/network load)
    const RECENT_ALERT_MAX_HOURS = 6;
    const getHotspotAgeHours = (r) => {
      if (!r?.acq_date) return null;
      const parts = String(r.acq_date).split("-");
      if (parts.length !== 3) return null;
      const y = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      const d = parseInt(parts[2], 10);
      const rawTime = String(r.acq_time || "0000").replace(":", "").padStart(4, "0");
      const hh = parseInt(rawTime.slice(0, 2), 10) || 0;
      const mm = parseInt(rawTime.slice(2, 4), 10) || 0;
      const acqMs = Date.UTC(y, m - 1, d, hh, mm, 0);
      if (isNaN(acqMs)) return null;
      return (Date.now() - acqMs) / 3600000;
    };

    const allLoaded = GFIState.hotspotsData?.hotspots || [];
    const rows = allLoaded.filter(
      (r) =>
        r.latitude >= centerLat - degSpan &&
        r.latitude <= centerLat + degSpan &&
        r.longitude >= centerLon - degSpan &&
        r.longitude <= centerLon + degSpan
    );

    const recentRows = rows.filter((r) => {
      const ageH = getHotspotAgeHours(r);
      return ageH !== null && ageH >= -0.5 && ageH <= RECENT_ALERT_MAX_HOURS;
    });

    if (recentRows.length > 0) {
      const qcOut = computeOfflineDualAiAnalysis(recentRows.slice(0, 60));
      const biomassFires =
        alertUserPrefs.aiStrict !== false
          ? (qcOut.zone_classification_counts || {}).ACTIVE_BIOMASS_FIRE ?? 0
          : recentRows.length;

      let nearestKm = Infinity;
      let maxFrp = 0;
      let nearestRow = null;
      let newestAgeH = Infinity;
      recentRows.forEach((r) => {
        const d = haversineKm(centerLat, centerLon, r.latitude, r.longitude);
        if (d < nearestKm) {
          nearestKm = d;
          nearestRow = r;
        }
        if ((r.frp || 0) > maxFrp) maxFrp = r.frp;
        const ageH = getHotspotAgeHours(r);
        if (ageH !== null && ageH < newestAgeH) newestAgeH = ageH;
      });

      const ageLabel =
        newestAgeH < 1
          ? `${Math.max(1, Math.round(newestAgeH * 60))} min ago`
          : `${newestAgeH.toFixed(1)} h ago`;

      const maxRadiusKm = alertUserPrefs.radiusKm || 120;
      const minFrpReq = alertUserPrefs.minFrp ?? 15;
      if (biomassFires >= 1 && nearestKm <= maxRadiusKm && maxFrp >= minFrpReq) {
        const alertSig = `${biomassFires}:${Math.round(nearestKm)}:${nearestRow?.acq_date || ""}:${nearestRow?.acq_time || ""}`;
        if (showClearAdvisory || window._lastChokiAlertSig !== alertSig) {
          window._lastChokiAlertSig = alertSig;
          showProximityToast(
            `Active Wildfire Threat — ${locLabel}`,
            `NASA FIRMS verified <strong>${biomassFires}</strong> recent fire pixels (${ageLabel}) near <strong>${centerLat.toFixed(2)}°, ${centerLon.toFixed(2)}°</strong>. Click <strong>Center on Fire</strong> to inspect.`,
            true,
            {
              nearestKm,
              activeCount: biomassFires,
              maxFrp,
              focusCoords: nearestRow ? { lat: nearestRow.latitude, lon: nearestRow.longitude } : null,
            }
          );
        }
      } else if (showClearAdvisory) {
        showProximityToast(
          `Area Clear — ${locLabel}`,
          `No recent wildfire detections in the last ${RECENT_ALERT_MAX_HOURS} hours around ${centerLat.toFixed(2)}°, ${centerLon.toFixed(2)}°.`,
          false
        );
      }
    } else if (showClearAdvisory) {
      showProximityToast(
        `✓ No Recent Wildfires near ${locLabel}`,
        `Live NASA FIRMS orbital check around ${centerLat.toFixed(2)}°, ${centerLon.toFixed(2)}° found 0 detections in the last ${RECENT_ALERT_MAX_HOURS} hours.`,
        false
      );
    }

    if (ingestedTotal > 0 || serverSyncedNew) {
      clearClientDataCaches();
      await refreshAllActiveData({ forceOverview: true, forceFetch: true });
    }
  } catch (_) {
    // Gracefully absorb any network error during background watchdog cycle
  } finally {
    if (dot) dot.classList.remove("syncing");
    nextWatchdogEpoch = Date.now() + WATCHDOG_INTERVAL_MS;
    if (navigator.onLine) {
      updateWatchdogCountdown();
    } else {
      updateConnectivityHud(true);
    }
  }
}

function updateWatchdogCountdown() {
  const dot = document.getElementById("hud-sync-dot");
  const lbl = document.getElementById("hud-sync-label");
  if (!lbl) return;
  if (!navigator.onLine) {
    if (dot) dot.style.background = "#f59e0b";
    lbl.textContent = "Offline Mode";
    return;
  }
  if (dot) dot.style.background = "#10b981";
  lbl.textContent = "Online";
}

function initSwathWatchdog(hasSavedCoords = false) {
  nextWatchdogEpoch = Date.now() + WATCHDOG_INTERVAL_MS;
  updateWatchdogCountdown();
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(updateWatchdogCountdown, 1000);

  if (swathWatchdogTimer) clearInterval(swathWatchdogTimer);
  swathWatchdogTimer = setInterval(() => runSwathWatchdogCycle(false), WATCHDOG_INTERVAL_MS);

  // Silent initial regional check + pre-populate Proof & QC metrics
  setTimeout(() => {
    loadAndRenderValidationProof();
    if (!hasSavedCoords && navigator.permissions?.query) {
      navigator.permissions.query({ name: "geolocation" }).then((perm) => {
        if (perm.state === "granted") {
          locateAndMonitorUserArea(false);
          return;
        }
        runSwathWatchdogCycle(false);
      }).catch(() => runSwathWatchdogCycle(false));
    } else {
      runSwathWatchdogCycle(false);
    }
  }, 1200);
}

/* ==========================================================================
   10. UTILITIES
   ========================================================================== */

function formatNum(val) {
  if (val === null || val === undefined || isNaN(val)) return "—";
  return Number(val).toLocaleString("en-US", { maximumFractionDigits: 1 });
}

function formatInt(val) {
  if (val === null || val === undefined || isNaN(val)) return "0";
  return Math.round(Number(val)).toLocaleString("en-US");
}

/* ==========================================================================
   11. MOTION-GRAPHICS SPLASH ENGINE (CONTINUOUS 60/120FPS METAMORPHOSIS)
   ========================================================================== */

function initChokiSplash() {
  const splash = document.getElementById("choki-splash");
  if (!splash) return Promise.resolve();

  const canvas = document.getElementById("choki-motion-canvas");
  const ctx = canvas ? canvas.getContext("2d") : null;
  const logoReveal = document.getElementById("splash-logo-reveal");
  const logoEmblem = document.getElementById("splash-logo-emblem");
  const captionEl = document.getElementById("splash-telemetry-caption");
  const skipBtn = document.getElementById("btn-skip-splash");

  if (!ctx || !canvas) {
    splash.remove();
    return Promise.resolve();
  }

  // Exact vector continent silhouettes from user's .earth-loader specification
  const continentShapes = [
    {
      path: new Path2D("M29.4,-17.4C33.1,1.8,27.6,16.1,11.5,31.6C-4.7,47,-31.5,63.6,-43,56C-54.5,48.4,-50.7,16.6,-41,-10.9C-31.3,-38.4,-15.6,-61.5,-1.4,-61C12.8,-60.5,25.7,-36.5,29.4,-17.4Z"),
      baseX: -72, baseY: 22, speed: 56, scale: 0.92,
      spots: [
        { ox: -14, oy: 4, r: 16, seed: 0.14 },
        { ox: -25, oy: -20, r: 11, seed: 0.22 },
        { ox: 4, oy: -12, r: 9.5, seed: 0.30 },
      ],
    },
    {
      path: new Path2D("M31.7,-55.8C40.3,-50,45.9,-39.9,49.7,-29.8C53.5,-19.8,55.5,-9.9,53.1,-1.4C50.6,7.1,43.6,14.1,41.8,27.6C40.1,41.1,43.4,61.1,37.3,67C31.2,72.9,15.6,64.8,1.5,62.2C-12.5,59.5,-25,62.3,-31.8,56.7C-38.5,51.1,-39.4,37.2,-49.3,26.3C-59.1,15.5,-78,7.7,-77.6,0.2C-77.2,-7.2,-57.4,-14.5,-49.3,-28.4C-41.2,-42.4,-44.7,-63,-38.5,-70.1C-32.2,-77.2,-16.1,-70.8,-2.3,-66.9C11.6,-63,23.1,-61.5,31.7,-55.8Z"),
      baseX: 16, baseY: -20, speed: 56, scale: 0.88,
      spots: [
        { ox: 12, oy: -4, r: 18, seed: 0.16 },
        { ox: -22, oy: -14, r: 13, seed: 0.24 },
        { ox: 16, oy: 34, r: 14, seed: 0.31 },
        { ox: -14, oy: 24, r: 11, seed: 0.36 },
      ],
    },
    {
      path: new Path2D("M30.6,-49.2C42.5,-46.1,57.1,-43.7,67.6,-35.7C78.1,-27.6,84.6,-13.8,80.3,-2.4C76.1,8.9,61.2,17.8,52.5,29.1C43.8,40.3,41.4,53.9,33.7,64C26,74.1,13,80.6,2.2,76.9C-8.6,73.1,-17.3,59,-30.6,52.1C-43.9,45.3,-61.9,45.7,-74.1,38.2C-86.4,30.7,-92.9,15.4,-88.6,2.5C-84.4,-10.5,-69.4,-20.9,-60.7,-34.6C-52.1,-48.3,-49.8,-65.3,-40.7,-70C-31.6,-74.8,-15.8,-67.4,-3.2,-61.8C9.3,-56.1,18.6,-52.3,30.6,-49.2Z"),
      baseX: 118, baseY: -14, speed: 62, scale: 0.85,
      spots: [
        { ox: 24, oy: -6, r: 17, seed: 0.18 },
        { ox: -14, oy: 4, r: 13, seed: 0.27 },
        { ox: -32, oy: -20, r: 10.5, seed: 0.34 },
      ],
    },
    {
      path: new Path2D("M39.4,-66C48.6,-62.9,51.9,-47.4,52.9,-34.3C53.8,-21.3,52.4,-10.6,54.4,1.1C56.3,12.9,61.7,25.8,57.5,33.2C53.2,40.5,39.3,42.3,28.2,46C17,49.6,8.5,55.1,1.3,52.8C-5.9,50.5,-11.7,40.5,-23.6,37.2C-35.4,34,-53.3,37.5,-62,32.4C-70.7,27.4,-70.4,13.7,-72.4,-1.1C-74.3,-15.9,-78.6,-31.9,-73.3,-43C-68.1,-54.2,-53.3,-60.5,-39.5,-60.9C-25.7,-61.4,-12.9,-56,1.1,-58C15.1,-59.9,30.2,-69.2,39.4,-66Z"),
      baseX: -165, baseY: 28, speed: 62, scale: 0.84,
      spots: [
        { ox: -14, oy: -24, r: 15, seed: 0.20 },
        { ox: 18, oy: -10, r: 12, seed: 0.29 },
        { ox: -28, oy: 8, r: 10.5, seed: 0.35 },
      ],
    },
  ];

  // Magma fracture polylines normalized in [-1..1] sphere coordinates
  const crackBranches = [
    [[-0.86, -0.26], [-0.46, -0.16], [-0.20, 0.10], [0.16, -0.02], [0.46, 0.20], [0.86, 0.04]],
    [[-0.20, 0.10], [-0.28, 0.50], [-0.04, 0.84]],
    [[0.16, -0.02], [0.28, -0.48], [0.54, -0.78]],
    [[-0.46, -0.16], [-0.58, -0.56]],
    [[0.46, 0.20], [0.42, 0.62], [0.60, 0.84]],
    [[-0.08, -0.78], [0.06, -0.34], [0.16, -0.02]],
  ];

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (e0, e1, x) => {
    const t = clamp01((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
  };
  const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * clamp01(t)));
  const easeInOutQuint = (t) => {
    t = clamp01(t);
    return t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;
  };
  const easeOutBack = (t) => {
    t = clamp01(t);
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  };
  const lerpRGB = (c1, c2, t) => {
    t = clamp01(t);
    return `rgb(${Math.round(lerp(c1[0], c2[0], t))}, ${Math.round(lerp(c1[1], c2[1], t))}, ${Math.round(lerp(c1[2], c2[2], t))})`;
  };

  let dpr = Math.min(window.devicePixelRatio || 1, 1.75);
  let width = 560;
  let height = 440;
  let canvasRect = canvas.getBoundingClientRect();
  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    canvasRect = canvas.getBoundingClientRect();
    width = Math.max(300, Math.round(canvasRect.width || 560));
    height = Math.max(260, Math.round(canvasRect.height || 440));
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener("resize", resize);

  // Offscreen sprite caches (zero gradient allocation per frame)
  const glowSprite = document.createElement("canvas");
  glowSprite.width = 256;
  glowSprite.height = 256;
  {
    const gctx = glowSprite.getContext("2d");
    const gg = gctx.createRadialGradient(128, 128, 18, 128, 128, 126);
    gg.addColorStop(0, "rgba(249, 115, 22, 0.50)");
    gg.addColorStop(0.55, "rgba(220, 38, 38, 0.24)");
    gg.addColorStop(1, "rgba(0, 0, 0, 0)");
    gctx.fillStyle = gg;
    gctx.fillRect(0, 0, 256, 256);
  }

  const heatSprite = document.createElement("canvas");
  heatSprite.width = 64;
  heatSprite.height = 64;
  {
    const hctx = heatSprite.getContext("2d");
    hctx.fillStyle = "rgba(253, 224, 71, 0.85)";
    hctx.beginPath();
    hctx.arc(32, 32, 30, 0, Math.PI * 2);
    hctx.fill();
    hctx.fillStyle = "rgba(249, 115, 22, 0.94)";
    hctx.beginPath();
    hctx.arc(32, 32, 20.4, 0, Math.PI * 2);
    hctx.fill();
    hctx.fillStyle = "#ef4444";
    hctx.beginPath();
    hctx.arc(32, 32, 10.8, 0, Math.PI * 2);
    hctx.fill();
  }

  // Pre-cached volumetric multi-lobe smoke puff sprite (zero per-frame gradient cost)
  const smokeSprite = document.createElement("canvas");
  smokeSprite.width = 96;
  smokeSprite.height = 96;
  {
    const sctx = smokeSprite.getContext("2d");
    const lobes = [
      [48, 48, 36, 0.36],
      [36, 42, 26, 0.24],
      [60, 44, 25, 0.24],
      [48, 32, 24, 0.20],
    ];
    lobes.forEach(([lx, ly, lr, alpha]) => {
      const sg = sctx.createRadialGradient(lx, ly, 2, lx, ly, lr);
      sg.addColorStop(0, `rgba(195, 204, 218, ${alpha})`);
      sg.addColorStop(0.55, `rgba(128, 138, 154, ${alpha * 0.55})`);
      sg.addColorStop(1, "rgba(65, 72, 85, 0)");
      sctx.fillStyle = sg;
      sctx.fillRect(0, 0, 96, 96);
    });
  }

  const smokePuffs = [];
  const spawnSmokePuff = (cx, cy, R, intensity) => {
    const side = Math.random() < 0.72 ? 1 : -1;
    const ox = side * R * (0.16 + Math.random() * 0.56);
    const oy = -R * (0.48 + Math.random() * 0.44);
    smokePuffs.push({
      x: cx + ox,
      y: cy + oy,
      vx: side * (0.45 + Math.random() * 0.7) + (Math.random() - 0.5) * 0.4,
      vy: -(1.25 + Math.random() * 1.15 * intensity),
      size: R * (0.36 + Math.random() * 0.28),
      grow: 0.72 + Math.random() * 0.55,
      rot: Math.random() * Math.PI * 2,
      vrot: (Math.random() - 0.5) * 0.04,
      life: 1.0,
      decay: 0.017 + Math.random() * 0.012,
      seed: Math.random() * 6.28,
    });
  };

  // Precomputed trigonometric lookup tables for smooth 84-point quadratic flame curve
  const FLAME_STEPS = 84;
  const flameTheta = new Float32Array(FLAME_STEPS);
  const flameCos = new Float32Array(FLAME_STEPS);
  const flameSin = new Float32Array(FLAME_STEPS);
  const flameUpWeight = new Float32Array(FLAME_STEPS);
  const flameSideSq = new Float32Array(FLAME_STEPS);
  const flameTipPow = new Float32Array(FLAME_STEPS);
  const flamePx = new Float32Array(FLAME_STEPS);
  const flamePy = new Float32Array(FLAME_STEPS);
  for (let i = 0; i < FLAME_STEPS; i++) {
    const th = (i / FLAME_STEPS) * Math.PI * 2;
    const c = Math.cos(th);
    const s = Math.sin(th);
    flameTheta[i] = th;
    flameCos[i] = c;
    flameSin[i] = s;
    flameUpWeight[i] = Math.pow(Math.max(0, (1 - s) * 0.5), 1.25);
    flameSideSq[i] = c * c;
    flameTipPow[i] = Math.pow(Math.max(0, -s), 3.2);
  }

  const sparks = [];
  const spawnSpark = (cx, cy, R, intensity) => {
    const a = Math.random() * Math.PI * 2;
    const rad = R * (0.65 + Math.random() * 0.42);
    const speed = 1.2 + Math.random() * (2.2 + intensity * 1.8);
    sparks.push({
      x: cx + Math.cos(a) * rad,
      y: cy + Math.sin(a) * rad,
      vx: Math.cos(a) * speed * 0.55 + (Math.random() - 0.5) * 0.8,
      vy: Math.sin(a) * speed * 0.35 - (1.4 + Math.random() * 2.2),
      life: 1,
      decay: 0.015 + Math.random() * 0.02,
      size: 1.4 + Math.random() * 2.3,
      hue: Math.random() < 0.35 ? 48 : Math.random() < 0.78 ? 25 : 8,
    });
  };

  const drawOrganicFlameLayer = (cx, cy, baseScaleR, timeSec, ampScale, squashToDrop, fillStyle, seedOffset) => {
    for (let i = 0; i < FLAME_STEPS; i++) {
      const th = flameTheta[i];
      const wave1 = Math.sin(th * 5 - timeSec * 5.6 + seedOffset);
      const wave2 = Math.sin(th * 9 + timeSec * 7.8 + seedOffset * 1.7) * 0.52;
      const wave3 = Math.cos(th * 13 - timeSec * 10.4 + seedOffset * 2.3) * 0.26;
      const flicker = Math.max(0, 0.36 + 0.64 * (0.5 + 0.5 * (wave1 + wave2 + wave3) / 1.78));

      const tipBoost = flameTipPow[i] * (baseScaleR * 0.52 * squashToDrop);
      const sidePinch = 1 - squashToDrop * 0.45 * flameSideSq[i];
      const reach = baseScaleR * (0.92 * sidePinch + ampScale * (0.12 + 0.42 * flameUpWeight[i]) * flicker) + tipBoost;
      flamePx[i] = cx + flameCos[i] * reach;
      flamePy[i] = cy + flameSin[i] * reach;
    }

    ctx.beginPath();
    const firstMidX = (flamePx[FLAME_STEPS - 1] + flamePx[0]) * 0.5;
    const firstMidY = (flamePy[FLAME_STEPS - 1] + flamePy[0]) * 0.5;
    ctx.moveTo(firstMidX, firstMidY);
    for (let i = 0; i < FLAME_STEPS; i++) {
      const next = (i + 1) % FLAME_STEPS;
      const midX = (flamePx[i] + flamePx[next]) * 0.5;
      const midY = (flamePy[i] + flamePy[next]) * 0.5;
      ctx.quadraticCurveTo(flamePx[i], flamePy[i], midX, midY);
    }
    ctx.closePath();
    ctx.fillStyle = fillStyle;
    ctx.fill();
  };

  const drawPolylineProgress = (cx, cy, R, pts, progress, strokeWidth, color) => {
    if (progress <= 0.01) return;
    let totalLen = 0;
    const segLens = [];
    for (let i = 1; i < pts.length; i++) {
      const dx = (pts[i][0] - pts[i - 1][0]) * R;
      const dy = (pts[i][1] - pts[i - 1][1]) * R;
      const d = Math.hypot(dx, dy);
      segLens.push(d);
      totalLen += d;
    }
    let remaining = totalLen * clamp01(progress);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = strokeWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(cx + pts[0][0] * R, cy + pts[0][1] * R);
    for (let i = 1; i < pts.length && remaining > 0; i++) {
      const seg = segLens[i - 1];
      const frac = Math.min(1, remaining / Math.max(seg, 0.001));
      const nx = lerp(pts[i - 1][0], pts[i][0], frac);
      const ny = lerp(pts[i - 1][1], pts[i][1], frac);
      ctx.lineTo(cx + nx * R, cy + ny * R);
      remaining -= seg;
    }
    ctx.stroke();
    ctx.restore();
  };

  const DURATION_MS = 2350;
  let startTs = null;
  let finished = false;
  let rafId = null;
  let brandRevealed = false;

  // Pre-decode SVG emblem before starting animation loop
  const emblemImg = logoEmblem?.querySelector("img");
  if (emblemImg?.decode) emblemImg.decode().catch(() => {});

  // Compute relative target emblem Y inside our centered stage canvas once
  let targetEmblemY = height * 0.5 - 58;
  if (logoEmblem) {
    const rect = logoEmblem.getBoundingClientRect();
    if (rect.height > 10 && canvasRect.height > 10) {
      targetEmblemY = rect.top - canvasRect.top + rect.height * 0.52;
    }
  }

  return new Promise((resolve) => {
    const closeSplash = () => {
      if (finished) return;
      finished = true;
      splash.classList.add("phase-exit");
      setTimeout(() => {
        if (rafId) cancelAnimationFrame(rafId);
        window.removeEventListener("resize", resize);
        splash.remove();
        resolve();
      }, 380);
    };

    skipBtn?.addEventListener("click", closeSplash);

    const frame = (ts) => {
      if (finished) return;
      if (startTs === null) startTs = ts;
      const elapsed = ts - startTs;
      const timeSec = elapsed / 1000;
      const p = clamp01(elapsed / DURATION_MS);

      ctx.clearRect(0, 0, width, height);

      // Continuous progressive easing (everything grows out from 0, zero sudden pops)
      const introScale = p < 0.16 ? lerp(0.76, 1.0, easeOutExpo(p / 0.16)) : 1.0;
      const heatPhase = smoothstep(0.08, 0.44, p);
      const charPhase = smoothstep(0.32, 0.62, p);
      const flameGrowth = smoothstep(0.32, 0.58, p);
      const flameFade = 1 - smoothstep(0.75, 0.86, p);
      const flameStrength = flameGrowth * flameFade;
      const morphT = easeInOutQuint(smoothstep(0.60, 0.82, p));
      const logoHandOff = easeOutExpo(smoothstep(0.72, 0.84, p));

      const baseCy = height * 0.46;
      const cx = width * 0.5;
      const cy = lerp(baseCy, targetEmblemY, morphT);
      const baseR = Math.max(72, Math.min(96, height * 0.21));
      const R = baseR * introScale * lerp(1.0, 0.54, morphT);

      if (captionEl) {
        if (p < 0.28) {
          captionEl.textContent = "MODIS + VIIRS ORBITAL SYNC";
        } else if (p < 0.60) {
          captionEl.textContent = "HARMONIZING GLOBAL FIRE DATA";
          captionEl.style.color = "rgba(253, 224, 71, 0.92)";
        } else {
          captionEl.style.opacity = String(1 - smoothstep(0.58, 0.70, p));
        }
      }

      // 1. Pre-cached ambient glow stamp
      if (flameStrength > 0.01) {
        const glowSize = R * (3.8 + 0.6 * flameGrowth);
        ctx.globalAlpha = flameStrength;
        ctx.drawImage(glowSprite, cx - glowSize * 0.5, cy - glowSize * 0.5, glowSize, glowSize);
        ctx.globalAlpha = 1;
      }

      // 2. Volumetric turbulent smoke plumes (pre-cached multi-lobe sprite)
      const smokeEmit = smoothstep(0.32, 0.50, p) * (1 - smoothstep(0.64, 0.74, p));
      if (smokeEmit > 0.12 && smokePuffs.length < 28 && Math.random() < 0.72 * smokeEmit) {
        spawnSmokePuff(cx, cy, R, flameStrength);
      }
      if (smokePuffs.length > 0) {
        const globalSmokeFade = 1 - smoothstep(0.68, 0.80, p);
        for (let i = smokePuffs.length - 1; i >= 0; i--) {
          const pf = smokePuffs[i];
          const curl = Math.sin(timeSec * 3.8 + pf.seed + pf.life * 4.0) * 0.65;
          pf.x += pf.vx + curl;
          pf.y += pf.vy;
          pf.vy *= 0.992;
          pf.size += pf.grow;
          pf.rot += pf.vrot;
          pf.life -= pf.decay;
          if (pf.life <= 0 || globalSmokeFade <= 0.01) {
            smokePuffs.splice(i, 1);
            continue;
          }
          const alpha = Math.sin(pf.life * Math.PI) * 0.42 * globalSmokeFade;
          if (alpha <= 0.01) continue;
          ctx.save();
          ctx.translate(pf.x, pf.y);
          ctx.rotate(pf.rot);
          ctx.globalAlpha = alpha;
          ctx.drawImage(smokeSprite, -pf.size * 0.5, -pf.size * 0.5, pf.size, pf.size);
          // Warm fire under-lighting near the combustion base
          if (pf.life > 0.55) {
            ctx.globalAlpha = (pf.life - 0.55) * 0.55 * flameFade;
            ctx.drawImage(glowSprite, -pf.size * 0.42, -pf.size * 0.36, pf.size * 0.84, pf.size * 0.84);
          }
          ctx.restore();
        }
      }

      // 3. Realistic multi-layer luminous fire (thermal gradient + additive incandescent core)
      if (flameStrength > 0.01) {
        const radiusScale = lerp(0.92, 1.07, flameGrowth);
        const fireGrad = ctx.createLinearGradient(cx, cy - R * 1.45, cx, cy + R * 1.05);
        fireGrad.addColorStop(0, `rgba(251, 146, 60, ${0.88 * flameFade})`);
        fireGrad.addColorStop(0.45, `rgba(239, 68, 68, ${0.95 * flameFade})`);
        fireGrad.addColorStop(1, `rgba(185, 28, 28, ${0.90 * flameFade})`);
        drawOrganicFlameLayer(cx, cy, R * radiusScale, timeSec * 1.9, 1.04 * flameGrowth, morphT, fireGrad, 0.0);

        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        drawOrganicFlameLayer(cx, cy, R * radiusScale * 0.95, timeSec * 2.25, 0.78 * flameGrowth, morphT, `rgba(249, 115, 22, ${0.65 * flameFade})`, 2.1);
        drawOrganicFlameLayer(cx, cy, R * radiusScale * 0.89, timeSec * 2.6, 0.54 * flameGrowth, morphT * 0.88, `rgba(250, 204, 21, ${0.58 * flameFade})`, 4.2);
        drawOrganicFlameLayer(cx, cy, R * radiusScale * 0.83, timeSec * 3.1, 0.34 * flameGrowth, morphT * 0.75, `rgba(254, 249, 195, ${0.42 * flameFade})`, 6.3);
        ctx.restore();
      }

      // 4. Aerodynamic incandescent embers (additive glow trails)
      if (flameStrength > 0.25 && sparks.length < 32 && Math.random() < 0.82 * flameStrength) {
        spawnSpark(cx, cy, R, flameStrength);
      }
      if (sparks.length > 0) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.lineCap = "round";
        for (let i = sparks.length - 1; i >= 0; i--) {
          const sp = sparks[i];
          sp.x += sp.vx * 1.55;
          sp.y += sp.vy * 1.55;
          sp.life -= sp.decay * 1.65;
          if (sp.life <= 0) {
            sparks.splice(i, 1);
            continue;
          }
          ctx.strokeStyle = `hsla(${sp.hue}, 100%, 66%, ${sp.life * (1 - logoHandOff * 0.85)})`;
          ctx.lineWidth = sp.size;
          ctx.beginPath();
          ctx.moveTo(sp.x, sp.y);
          ctx.lineTo(sp.x - sp.vx * 2.6, sp.y - sp.vy * 2.6);
          ctx.stroke();
        }
        ctx.restore();
      }

      // 5. Clipped Earth Sphere -> Seamless Continents -> Pre-cached Heat Sprites -> Cracks
      const globeAlpha = 1 - smoothstep(0.70, 0.80, p);
      if (globeAlpha > 0.01) {
        ctx.save();
        ctx.globalAlpha = globeAlpha;
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.clip();

        ctx.fillStyle = lerpRGB([51, 68, 193], [24, 10, 7], charPhase);
        ctx.fillRect(cx - R - 2, cy - R - 2, R * 2 + 4, R * 2 + 4);

        const SPAN_U = 280;
        const unitScale = R / 76;
        const landFill = lerpRGB([124, 193, 51], [69, 32, 18], charPhase);

        for (let ci = 0; ci < continentShapes.length; ci++) {
          const c = continentShapes[ci];
          const angularVel = c.speed * 2.15;
          const wrapped = ((((c.baseX - timeSec * angularVel) % SPAN_U) + SPAN_U) % SPAN_U) - SPAN_U * 0.5;
          for (let wi = -1; wi <= 1; wi++) {
            const worldX = cx + (wrapped + wi * SPAN_U) * unitScale;
            const worldY = cy + c.baseY * unitScale;
            if (worldX < cx - R * 2.1 || worldX > cx + R * 2.1) continue;

            ctx.save();
            ctx.translate(worldX, worldY);
            const tilt = ((worldX - cx) / R) * 0.14;
            ctx.transform(c.scale * unitScale, tilt * unitScale, 0, c.scale * unitScale, 0, 0);
            ctx.fillStyle = landFill;
            ctx.fill(c.path);

            if (heatPhase > 0.005) {
              for (let si = 0; si < c.spots.length; si++) {
                const sp = c.spots[si];
                const startP = 0.06 + (sp.seed - 0.14) * 0.85;
                const grow = easeOutExpo(smoothstep(startP, startP + 0.16, p));
                if (grow <= 0.01) continue;
                const rad = sp.r * grow * (1 + 0.06 * Math.sin(timeSec * 7 + sp.seed * 20));
                ctx.globalAlpha = globeAlpha * Math.min(1, grow * 1.15);
                ctx.drawImage(heatSprite, sp.ox - rad, sp.oy - rad, rad * 2, rad * 2);
              }
            }
            ctx.restore();
          }
        }

        const crackProg = smoothstep(0.32, 0.58, p);
        if (crackProg > 0.01) {
          crackBranches.forEach((pts, idx) => {
            const localP = clamp01((crackProg - idx * 0.05) / 0.72);
            drawPolylineProgress(cx, cy, R, pts, localP, 5.2, "rgba(249, 115, 22, 0.55)");
            drawPolylineProgress(cx, cy, R, pts, localP, 2.1, "#fde047");
          });
        }

        // Specular top crescent highlight & bottom hemisphere shadow (user's box-shadow look)
        const specAlpha = 0.24 * (1 - charPhase * 0.55);
        ctx.fillStyle = `rgba(255, 255, 255, ${specAlpha})`;
        ctx.beginPath();
        ctx.arc(cx, cy + R * 0.14, R * 1.02, Math.PI, Math.PI * 2);
        ctx.arc(cx, cy, R * 1.02, 0, Math.PI, true);
        ctx.fill();

        const rimGrad = ctx.createLinearGradient(cx, cy - R, cx, cy + R);
        rimGrad.addColorStop(0, "rgba(0,0,0,0)");
        rimGrad.addColorStop(0.75, "rgba(0,0,0,0)");
        rimGrad.addColorStop(1, "rgba(0,0,0,0.34)");
        ctx.fillStyle = rimGrad;
        ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

        ctx.restore();
      }

      // 6. REAL GEOMETRIC MORPH: White Planet Border -> Tilted Chokí Blue Orbital Ring
      const ringAlpha = 1 - smoothstep(0.80, 0.87, p);
      if (ringAlpha > 0.01) {
        const ringRx = R * lerp(1.0, 1.38, morphT);
        const ringRy = R * lerp(1.0, 0.42, morphT);
        const ringTilt = lerp(0, -0.46, morphT);
        const ringColor = lerpRGB([255, 255, 255], [14, 165, 233], morphT);
        const ringWidth = lerp(Math.max(3.2, R * 0.045), 5.5, morphT);

        ctx.save();
        ctx.globalAlpha = ringAlpha;
        ctx.translate(cx, cy);
        ctx.rotate(ringTilt);
        ctx.strokeStyle = ringColor;
        ctx.lineWidth = ringWidth;
        ctx.beginPath();
        ctx.ellipse(0, 0, ringRx, ringRy, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // 7. Anamorphic light streak at exact metamorphosis handoff + Official Logo Reveal
      const flareAlpha = Math.sin(clamp01((p - 0.74) / 0.14) * Math.PI);
      if (flareAlpha > 0.01 && p >= 0.74 && p <= 0.89) {
        const flareW = width * 0.42 * flareAlpha;
        const flareGrad = ctx.createLinearGradient(cx - flareW, cy, cx + flareW, cy);
        flareGrad.addColorStop(0, "rgba(253, 224, 71, 0)");
        flareGrad.addColorStop(0.35, `rgba(249, 115, 22, ${0.42 * flareAlpha})`);
        flareGrad.addColorStop(0.5, `rgba(255, 255, 255, ${0.85 * flareAlpha})`);
        flareGrad.addColorStop(0.65, `rgba(56, 189, 248, ${0.42 * flareAlpha})`);
        flareGrad.addColorStop(1, "rgba(56, 189, 248, 0)");
        ctx.fillStyle = flareGrad;
        ctx.fillRect(cx - flareW, cy - 1.5, flareW * 2, 3);
      }

      if (logoReveal) {
        const revScale = lerp(0.84, 1.0, easeOutExpo(logoHandOff));
        logoReveal.style.opacity = String(logoHandOff);
        logoReveal.style.transform = `scale(${revScale})`;
      }

      if (p >= 0.80 && !brandRevealed) {
        brandRevealed = true;
        splash.classList.add("reveal-brand");
      }

      if (p >= 1) {
        closeSplash();
        return;
      }

      rafId = requestAnimationFrame(frame);
    };

    rafId = requestAnimationFrame(frame);
  });
}
