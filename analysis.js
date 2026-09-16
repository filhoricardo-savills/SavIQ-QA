/* ============================================================================
   SavIQ meter analysis — browser port of app_v11.py

   Same checks, same thresholds, same wording, so results match what the team
   has been seeing from the Streamlit tool. Function names follow the Python
   so the two can be read side by side.

   Differences that are deliberate:
   - DEXMA is reached through /api/dexma (the API sends no CORS headers).
   - Readings are plain arrays of {ts, value} instead of DataFrames.
   - Naive DEXMA timestamps are treated as UTC, exactly as pandas did with
     utc=True followed by tz_localize(None). All hour maths is UTC.
   ============================================================================ */
(function () {
  "use strict";

  const DONE = "Done", ISSUE = "Issue";

  const DEFAULT_SETTINGS = {
    availability_threshold: 90.0, max_allowed_gap_hours: 48,
    zero_run_threshold_hours: 48, peak_multiplier: 8.0,
    monthly_change_threshold: 15.0, max_parameter_attempts: 1,
    peak_history_enabled: false, historical_comparisons_enabled: true,
    retries: 2, pause_ms: 0
  };

  const CHECK_COLUMNS = ["Meter access / parameter", "Current readings", "Availability",
    "Missing gaps", "Consecutive zeros", "Unusual peaks", "Year-over-year change"];

  /* ------------------------------------------------------------------ */
  /* small helpers                                                       */
  /* ------------------------------------------------------------------ */
  const textValue = v => (v === null || v === undefined || v === "") ? "" : String(v).trim();
  const safeFloat = v => {
    if (v === "" || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const pad2 = n => String(n).padStart(2, "0");
  const isoDate = d => d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
  const utcDate = (y, m, d) => new Date(Date.UTC(y, m, d));           // m is 0-based
  const parseDateOnly = s => { const [y, m, d] = s.split("-").map(Number); return utcDate(y, m - 1, d); };

  /* pandas to_datetime(utc=True) on a naive string assumes UTC; JS's Date
     would assume local. Force UTC when no offset is present. */
  function parseTs(s) {
    if (s === null || s === undefined || s === "") return null;
    const t = String(s).trim();
    const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(t);
    const d = new Date(hasZone ? t : t + "Z");
    return isNaN(d) ? null : d;
  }
  const floorHour = d => new Date(Math.floor(d.getTime() / 3600000) * 3600000);

  function quantile(sorted, q) {          // pandas default: linear interpolation
    if (!sorted.length) return NaN;
    const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  const median = arr => quantile(arr.slice().sort((a, b) => a - b), 0.5);

  const displayNumber = (v, suffix) => (v === null || v === undefined || Number.isNaN(v))
    ? "Not available"
    : Number(v).toLocaleString("en-IE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (suffix || "");

  /* ------------------------------------------------------------------ */
  /* dates                                                               */
  /* ------------------------------------------------------------------ */
  const monthEnd = m => utcDate(m.getUTCFullYear(), m.getUTCMonth() + 1, 0);
  function addMonths(d, n) {
    const y = d.getUTCFullYear(), idx = d.getUTCMonth() + n;
    const yy = y + Math.floor(idx / 12), mm = ((idx % 12) + 12) % 12;
    const last = utcDate(yy, mm + 1, 0).getUTCDate();
    return utcDate(yy, mm, Math.min(d.getUTCDate(), last));
  }
  const previous12MonthRange = m => [addMonths(m, -12), monthEnd(addMonths(m, -1))];
  const sameMonthPreviousYear = m => { const s = addMonths(m, -12); return [s, monthEnd(s)]; };
  const expectedHourlyPoints = (s, e) => Math.max(0, Math.round((e - s) / 86400000) + 1) * 24;
  const dexmaDatetime = d => isoDate(d) + "T" + pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + ":" + pad2(d.getUTCSeconds());

  /* ------------------------------------------------------------------ */
  /* DEXMA client, via the relay                                         */
  /* ------------------------------------------------------------------ */
  class DexmaApiError extends Error {
    constructor(message, opts) {
      super(message);
      const o = opts || {};
      this.category = o.category || "service";
      this.statusCode = o.statusCode || null;
      this.fatal = o.fatal !== undefined ? o.fatal : true;
      this.retryAfter = o.retryAfter || null;
    }
  }

  class DexmaClient {
    constructor(token, sessionJwt, opts) {
      const o = opts || {};
      this.token = String(token || "").trim();
      this.session = sessionJwt;
      this.retries = Math.max(1, Math.min(5, o.retries || DEFAULT_SETTINGS.retries));
      this.pauseMs = Math.max(0, Math.min(5000, o.pause_ms || 0));
      this.callLog = [];
      this._readingsCache = new Map();
      this.cacheHits = 0;
    }
    close() { this._readingsCache.clear(); this.token = ""; }

    static retryDelay(headers) {
      const delays = [];
      for (const f of ["retry-after", "x-ratelimit-hour-reset", "x-ratelimit-day-reset"]) {
        const v = headers.get(f);
        if (v === null) continue;
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) { delays.push(n); continue; }
        if (f === "retry-after") {
          const dt = new Date(v);
          if (!isNaN(dt)) delays.push(Math.max(0, (dt - Date.now()) / 1000));
        }
      }
      return delays.length ? Math.max.apply(null, delays) : 2.0;
    }

    async get(path, params) {
      if (!["/devices", "/locations", "/parameters", "/readings"].includes(path))
        throw new DexmaApiError("Unsupported API operation.", { category: "configuration" });
      const key = JSON.stringify(Object.keys(params).sort().map(k => [k, params[k]]));
      if (path === "/readings" && this._readingsCache.has(key)) {
        this.cacheHits++;
        return JSON.parse(JSON.stringify(this._readingsCache.get(key)));
      }
      const qs = new URLSearchParams(Object.assign({ path }, params)).toString();
      let waited = 0;
      for (let attempt = 1; attempt <= this.retries; attempt++) {
        const started = performance.now();
        let r;
        try {
          r = await fetch("/api/dexma?" + qs, {
            headers: { "x-dexcell-token": this.token, "x-qa-session": this.session }
          });
        } catch (e) {
          this.callLog.push({ path, status: "network_error", attempt, ms: Math.round(performance.now() - started) });
          if (attempt < this.retries) { await sleep(1500 * attempt); continue; }
          throw new DexmaApiError("The data service could not be reached. Check the connection and retry.", { category: "network" });
        }
        const status = r.status;
        this.callLog.push({ path, status, attempt, ms: Math.round(performance.now() - started),
          hourRemaining: safeFloat(r.headers.get("x-ratelimit-hour-remaining")),
          dayRemaining: safeFloat(r.headers.get("x-ratelimit-day-remaining")) });

        if (status === 401 && (await r.clone().json().catch(() => ({}))).error === "Sign in to Meter QA Review first.")
          throw new DexmaApiError("Your Meter QA Review session has expired. Sign in again.", { category: "session" });
        if (status === 401 || status === 403) {
          throw new DexmaApiError(status === 401
            ? "The token was not accepted. Check the token with your project lead."
            : "This token does not have access to the requested data. Check account permissions.",
            { category: status === 401 ? "authentication" : "permission", statusCode: status });
        }
        if (status === 429) {
          const delay = DexmaClient.retryDelay(r.headers);
          if (attempt < this.retries && delay <= 10 && waited + delay <= 10) { await sleep(delay * 1000); waited += delay; continue; }
          throw new DexmaApiError("The API quota is exhausted. Retry after approximately " + Math.max(1, Math.round(delay)) +
            " seconds, or check the quota with your administrator.", { category: "rate_limit", statusCode: 429, retryAfter: delay });
        }
        if (status >= 500) {
          if (attempt < this.retries) { await sleep(1500 * attempt); continue; }
          throw new DexmaApiError("The data service is temporarily unavailable. Retry later.", { category: "service", statusCode: status });
        }
        if (status >= 400) {
          const perMeter = (path === "/readings" || path === "/parameters") && [400, 404, 422].includes(status);
          throw new DexmaApiError("The API could not supply this resource (HTTP " + status + ").",
            { category: "resource", statusCode: status, fatal: !perMeter });
        }
        let payload;
        try {
          payload = (status === 204 && path === "/readings") ? { values: [], units: "", timezone: "" } : await r.json();
        } catch (e) {
          throw new DexmaApiError("The API returned an unreadable response. No completed report was created.", { category: "response" });
        }
        if (this.pauseMs) await sleep(this.pauseMs);
        if (path === "/readings" && payload && Array.isArray(payload.values) && payload.values.length <= 10000) {
          this._readingsCache.set(key, JSON.parse(JSON.stringify(payload)));
          while (this._readingsCache.size > 8) this._readingsCache.delete(this._readingsCache.keys().next().value);
        }
        return payload;
      }
      throw new DexmaApiError("The data service did not complete the request.", { category: "service" });
    }
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function strictListPayload(payload) {
    let items = Array.isArray(payload) ? payload : null;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      for (const k of ["items", "results", "data", "values"]) if (Array.isArray(payload[k])) { items = payload[k]; break; }
    }
    if (!items || items.some(i => !i || typeof i !== "object" || Array.isArray(i)))
      throw new DexmaApiError("The API list response has an unexpected structure. Scope could not be verified.", { category: "response" });
    return items;
  }

  /* ------------------------------------------------------------------ */
  /* readings                                                            */
  /* ------------------------------------------------------------------ */
  function parseReadingPayload(payload) {
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.values))
      throw new DexmaApiError("The readings response has an unexpected structure.", { category: "response" });
    if (payload.values.some(i => !i || typeof i !== "object" || !("ts" in i) || !("v" in i)))
      throw new DexmaApiError("The readings response contains malformed measurements.", { category: "response" });
    return { values: payload.values, units: String(payload.units || ""), timezone: String(payload.timezone || "") };
  }

  async function fetchReadings(client, deviceId, parameterKey, startDate, endDate, resolution) {
    const startDt = startDate;
    const endExclusive = new Date(endDate.getTime() + 86400000);
    return parseReadingPayload(await client.get("/readings", {
      device_id: deviceId, parameter_key: parameterKey, operation: "DELTA", resolution,
      from: dexmaDatetime(startDt), to: dexmaDatetime(endExclusive), rounded: "NONE"
    }));
  }

  /* a "frame" is just an array of {ts, tsRaw, value} */
  const readingsToFrame = payload => payload.values.map(i => ({ tsRaw: i.ts, ts: parseTs(i.ts), value: safeFloat(i.v) }));
  const hasUsableValues = f => f.some(r => r.value !== null);

  function countAvailableAndZeroes(frame) {
    if (!frame.length) return [0, 0, 0];
    const valid = frame.filter(r => r.value !== null && r.ts);
    const seen = new Set(); let unique = 0, dup = 0;
    for (const r of valid) { const k = r.ts.getTime(); if (seen.has(k)) dup++; else { seen.add(k); unique++; } }
    const zeros = valid.filter(r => r.value === 0).length;
    return [unique, zeros, dup];
  }

  function sumValues(frame) {
    if (!frame.length) return null;
    const seen = new Set(); let total = 0, any = false;
    for (const r of frame) {
      if (seen.has(r.tsRaw)) continue; seen.add(r.tsRaw);
      if (r.value !== null) { total += r.value; any = true; }
    }
    return any ? total : null;
  }

  function longestMissingGapHours(frame, startDate, endDate) {
    const actual = new Set(frame.filter(r => r.value !== null && r.ts).map(r => floorHour(r.ts).getTime()));
    let longest = 0, current = 0;
    const end = endDate.getTime() + 23 * 3600000;
    for (let t = startDate.getTime(); t <= end; t += 3600000) {
      if (actual.has(t)) current = 0; else { current++; longest = Math.max(longest, current); }
    }
    return longest;
  }

  function maxZeroRunHours(frame) {
    const rows = frame.filter(r => r.ts).sort((a, b) => a.ts - b.ts);
    const deduped = []; const seen = new Set();
    for (const r of rows) { const k = r.ts.getTime(); if (!seen.has(k)) { seen.add(k); deduped.push(r); } }
    let longest = 0, current = 0, prev = null;
    for (const r of deduped) {
      if (prev === null || r.ts - prev !== 3600000) current = 0;
      current = r.value === 0 ? current + 1 : 0;
      longest = Math.max(longest, current);
      prev = r.ts;
    }
    return longest;
  }

  function preparedHourlyValues(frame) {
    const rows = frame.filter(r => r.ts && r.value !== null).sort((a, b) => a.ts - b.ts);
    const out = []; const seen = new Set();
    for (const r of rows) {
      const k = r.ts.getTime(); if (seen.has(k)) continue; seen.add(k);
      const dow = r.ts.getUTCDay();                    // 0 = Sunday
      out.push({ ts: r.ts, value: r.value, hour: r.ts.getUTCHours(),
        dayType: (dow === 0 || dow === 6) ? "weekend" : "weekday" });
    }
    return out;
  }

  function assessPeaks(currentFrame, historicalFrame, fallbackMultiplier, historicalMargin) {
    fallbackMultiplier = fallbackMultiplier || 8.0; historicalMargin = historicalMargin || 1.5;
    const current = preparedHourlyValues(currentFrame), history = preparedHourlyValues(historicalFrame || []);
    const result = { flagged: false, count: 0, checked: 0, total: current.length, value: null,
      threshold: null, timestamp: "", method: "Not checked", note: "", limitation: "" };
    if (!current.length) { result.limitation = "Peak check unavailable: no usable hourly readings."; return result; }

    const positive = current.filter(r => r.value > 0).map(r => r.value).sort((a, b) => a - b);
    let fallback = null;
    if (current.length >= 24 && positive.length >= 8) {
      const q1 = quantile(positive, .25), q3 = quantile(positive, .75);
      fallback = Math.max(q3 + 3 * (q3 - q1), quantile(positive, .5) * fallbackMultiplier);
    }
    const limits = new Map();
    if (history.length) {
      const groups = new Map();
      for (const r of history) { const k = r.dayType + "|" + r.hour; (groups.get(k) || groups.set(k, []).get(k)).push(r.value); }
      for (const [k, vals] of groups) {
        const pos = vals.filter(v => v > 0);
        if (vals.length >= 20 && pos.length >= 8) {
          const s = vals.slice().sort((a, b) => a - b);
          const q1 = quantile(s, .25), q3 = quantile(s, .75);
          const limit = Math.max(q3 + 3 * (q3 - q1), median(pos) * historicalMargin);
          if (limit > 0) limits.set(k, limit);
        }
      }
    }
    const comparisons = []; let fallbackCount = 0;
    for (const r of current) {
      let threshold = limits.get(r.dayType + "|" + r.hour), method = "Historical same-hour weekday/weekend";
      if (threshold === undefined) { threshold = fallback; method = "Current-month fallback"; if (threshold !== null) fallbackCount++; }
      if (threshold === null || threshold === undefined) continue;
      comparisons.push({ value: r.value, threshold, method, ratio: r.value / threshold, flagged: r.value > threshold,
        timestamp: isoDate(r.ts) + " " + pad2(r.ts.getUTCHours()) + ":" + pad2(r.ts.getUTCMinutes()) });
    }
    const flagged = comparisons.filter(c => c.flagged);
    result.flagged = flagged.length > 0; result.count = flagged.length; result.checked = comparisons.length;
    if (comparisons.length) {
      const pool = flagged.length ? flagged : comparisons;
      const rep = pool.reduce((a, b) => b.ratio > a.ratio ? b : a);
      result.value = rep.value; result.threshold = rep.threshold; result.timestamp = rep.timestamp; result.method = rep.method;
    }
    if (flagged.length) {
      result.note = flagged.length + " unusual hourly reading(s). Strongest exceedance at " + result.timestamp + ": " +
        displayNumber(result.value) + " against threshold " + displayNumber(result.threshold) + " (" + result.method + ").";
    }
    const lim = [];
    if (fallbackCount) lim.push(fallbackCount + " hour(s) used the current-month fallback because comparable history was insufficient or mostly zero.");
    if (comparisons.length < current.length) lim.push((current.length - comparisons.length) + " hour(s) could not be screened: insufficient positive baseline data.");
    result.limitation = lim.join(" ");
    return result;
  }

  const pctChange = (cur, base) => (cur === null || base === null || base === 0) ? null : Math.round(((cur - base) / base) * 10000) / 100;
  const availabilityPct = (actual, expected) => expected <= 0 ? null : Math.round(Math.min(100, (actual / expected) * 100) * 100) / 100;

  /* ------------------------------------------------------------------ */
  /* devices                                                             */
  /* ------------------------------------------------------------------ */
  const directId = d => (d.id === null || d.id === undefined) ? "" : String(d.id);
  const DEVICE_KEY_FIELDS = ["key", "device_key", "deviceKey", "local_key", "localKey", "local_id", "localId", "localID", "code"];
  const DEVICE_KEY_CONTAINERS = ["device", "meter", "asset", "identifiers", "metadata"];
  const GROUP_KEY_PREFIXES = ["G_", "G-"], DD_KEY_PREFIXES = ["DD_", "DD-"];
  const RETIREMENT_MARKERS = ["archive", "deactivat"];

  function deviceKeyValues(device) {
    const values = [];
    const add = v => { if (v === null || v === undefined || v === "" || typeof v === "object") return;
      const t = String(v).trim(); if (t && !values.includes(t)) values.push(t); };
    const visit = (v, depth) => {
      if (depth > 3) return;
      if (Array.isArray(v)) { v.forEach(i => visit(i, depth + 1)); return; }
      if (!v || typeof v !== "object") return;
      for (const f of DEVICE_KEY_FIELDS) {
        if (!(f in v)) continue;
        const c = v[f];
        if (c && typeof c === "object") visit(c, depth + 1); else add(c);
      }
      for (const c of DEVICE_KEY_CONTAINERS) { const n = v[c]; if (n && typeof n === "object") visit(n, depth + 1); }
    };
    visit(device, 0);
    return values;
  }
  const deviceLocalId = d => { const c = deviceKeyValues(d); return c.length ? c[0] : ""; };
  const hasDeviceKeyPrefix = (d, prefixes) => deviceKeyValues(d).some(v => prefixes.some(p => v.trim().toUpperCase().startsWith(p.toUpperCase())));
  const containsRetirementMarker = v => { const t = textValue(v).toLowerCase(); return RETIREMENT_MARKERS.some(m => t.includes(m)); };
  const deviceKeyHasRetirementMarker = d => deviceKeyValues(d).some(containsRetirementMarker);
  const deviceName = d => (d.name === null || d.name === undefined || d.name === "") ? "" : String(d.name);

  function deviceLocationName(d) {
    if (d._saviq_location_name) return String(d._saviq_location_name);
    const loc = d.location;
    if (loc && typeof loc === "object") { for (const k of ["name", "key"]) if (loc[k]) return String(loc[k]); }
    for (const k of ["location_name", "locationName", "location_key", "locationKey"]) if (d[k]) return String(d[k]);
    if (loc && typeof loc === "object" && loc.id !== null && loc.id !== undefined && loc.id !== "") return String(loc.id);
    if (loc !== null && loc !== undefined && loc !== "" && typeof loc !== "object") return String(loc);
    return "";
  }
  function deviceLocationId(d) {
    const loc = d.location;
    if (loc && typeof loc === "object" && loc.id !== null && loc.id !== undefined && loc.id !== "") return String(loc.id);
    if (loc !== null && loc !== undefined && loc !== "" && typeof loc !== "object") return String(loc);
    for (const k of ["location_id", "locationId"]) if (d[k]) return String(d[k]);
    return "";
  }
  const deviceHasEmbeddedLocationName = d => {
    const loc = d.location;
    if (loc && typeof loc === "object" && (loc.name || loc.key)) return true;
    return ["location_name", "locationName", "location_key", "locationKey"].some(k => d[k]);
  };
  function ignoredDeviceReason(d) {
    if (hasDeviceKeyPrefix(d, GROUP_KEY_PREFIXES)) return "G group key prefix";
    if (hasDeviceKeyPrefix(d, DD_KEY_PREFIXES)) return "DD key prefix";
    if (deviceKeyHasRetirementMarker(d)) return "archive/deactivated device key";
    if (containsRetirementMarker(deviceName(d))) return "device name";
    if (containsRetirementMarker(deviceLocationName(d))) return "location name";
    return "excluded device";
  }
  const isIgnoredDevice = d => hasDeviceKeyPrefix(d, GROUP_KEY_PREFIXES.concat(DD_KEY_PREFIXES)) ||
    deviceKeyHasRetirementMarker(d) || containsRetirementMarker(deviceName(d)) || containsRetirementMarker(deviceLocationName(d));

  function inferUtility(name) {
    if (name.includes("_")) return name.split("_", 1)[0].trim().toUpperCase();
    const up = name.toUpperCase();
    for (const u of ["ELEC", "GAS", "WAT", "WST", "THERMAL"]) if (up.includes(u)) return u;
    return "";
  }
  function inferLlType(name) {
    const parts = name.split("_"), marker = parts.length > 3 ? parts[3].toUpperCase() : "";
    if (marker === "WB") return "Whole Building";
    if (marker === "CA") return "Landlord";
    return name ? "Tenant" : "";
  }
  const isMonthlyQa = row => { const t = (row.data_source + " " + row.utility + " " + row.device_name).toLowerCase();
    return t.includes("manual") || t.includes("low frequency") || row.utility.toUpperCase() === "WST"; };

  function nestedName(v, field) {
    const n = v[field];
    if (n && typeof n === "object") for (const k of ["name", "key", "id"]) if (n[k] !== null && n[k] !== undefined && n[k] !== "") return String(n[k]);
    return "";
  }
  function dataSourceFromDevice(d, utility) {
    const ds = nestedName(d, "datasource");
    if (ds) return "New DEXMA device - review source (" + ds + ")";
    if (utility.toUpperCase() === "WST") return "New DEXMA device - review manual/low-frequency source";
    return "New DEXMA device - review data source";
  }
  function trackerRowFromDevice(d, rowNumber, defaultBuilding) {
    const name = deviceName(d) || deviceLocalId(d) || directId(d);
    const utility = inferUtility(name);
    return { row_number: rowNumber, building: deviceLocationName(d) || defaultBuilding, ll_type: inferLlType(name),
      device_name: name, utility, device_key: deviceLocalId(d) || directId(d),
      data_source: dataSourceFromDevice(d, utility), is_new_discovery: false, discovered_device_id: directId(d) };
  }

  async function fetchAccountDevices(client, pageSize, maxPages) {
    pageSize = Math.max(1, Math.min(500, pageSize || 500)); maxPages = maxPages || 200;
    const devices = [], seen = new Set();
    for (let p = 0; p < maxPages; p++) {
      const page = strictListPayload(await client.get("/devices", { status: "ACCEPTED", start: p * pageSize, limit: pageSize }));
      if (!page.length) return devices;
      for (const d of page) {
        const k = directId(d);
        if (!k || String(d.status || "ACCEPTED").toUpperCase() !== "ACCEPTED")
          throw new DexmaApiError("Discovery returned a device without an ID or accepted status. Scope could not be verified.", { category: "discovery" });
        if (seen.has(k)) throw new DexmaApiError("Discovery returned overlapping or repeated pages. Scope could not be verified.", { category: "discovery" });
        seen.add(k); devices.push(d);
      }
      if (page.length < pageSize) return devices;
    }
    throw new DexmaApiError("Discovery reached its page limit. Ask the administrator to check the account size.", { category: "discovery" });
  }
  async function fetchLocationNames(client) {
    const names = {};
    for (const loc of strictListPayload(await client.get("/locations", {}))) {
      const id = directId(loc), name = textValue(loc.name) || textValue(loc.key);
      if (id && name) names[id] = name;
    }
    return names;
  }
  async function resolveDeviceLocationNames(client, devices) {
    const unresolved = new Set(devices.filter(d => deviceLocationId(d) && !deviceHasEmbeddedLocationName(d)).map(deviceLocationId));
    if (!unresolved.size) return {};
    const names = await fetchLocationNames(client);
    for (const d of devices) { const n = names[deviceLocationId(d)]; if (n) d._saviq_location_name = n; }
    const out = {}; for (const id of unresolved) if (names[id]) out[id] = names[id];
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* parameters                                                          */
  /* ------------------------------------------------------------------ */
  const parameterText = p => ["key", "name", "nature", "units", "icon"].map(k => p[k]).filter(v => v !== null && v !== undefined && v !== "").map(v => String(v).toLowerCase()).join(" ");
  const parameterKey = p => { let v = p.key; if (v === null || v === undefined || v === "") v = p.id; return (v === null || v === undefined || v === "") ? "" : String(v); };
  function consumptionParameter(p) {
    const text = parameterText(p).replace(/³/g, "3").replace(/²/g, "2");
    const excluded = ["temperature", "humidity", "pressure", "voltage", "power factor", "reactive", "irradiance", "co2", "frequency", "demand", "power"];
    if (excluded.some(t => text.includes(t))) return false;
    const units = textValue(p.units).toLowerCase().replace(/³/g, "3").trim();
    return parameterKey(p).toUpperCase() === "EACTIVE" ||
      ["wh", "kwh", "mwh", "gwh", "m3", "l", "litre", "litres", "kg", "t", "ton", "tonne", "tonnes"].includes(units) ||
      ["consumption", "active energy", "water volume", "gas volume", "waste weight"].some(t => text.includes(t));
  }
  function scoreParameter(row, p) {
    const text = parameterText(p), key = parameterKey(p).toLowerCase(), utility = row.utility.toUpperCase();
    let score = 0; const reasons = [];
    if (utility === "ELEC") {
      if (key === "eactive") { score += 120; reasons.push("preferred ELEC key EACTIVE"); }
      if (text.includes("active") && (text.includes("energy") || text.includes("kwh"))) { score += 55; reasons.push("active energy"); }
      if (text.includes("kwh")) { score += 25; reasons.push("kWh units"); }
      if (text.includes("reactive")) score -= 40;
    } else if (utility === "WAT") {
      if (text.includes("water") || key.startsWith("wat")) { score += 80; reasons.push("water parameter"); }
      if (text.includes("m3") || text.includes("lit")) { score += 25; reasons.push("volume units"); }
    } else if (utility === "GAS") {
      if (text.includes("gas")) { score += 80; reasons.push("gas parameter"); }
      if (text.includes("kwh") || text.includes("m3")) { score += 20; reasons.push("gas consumption units"); }
    } else if (utility === "WST") {
      if (text.includes("waste") || text.includes("kg") || text.includes("ton")) { score += 70; reasons.push("waste parameter"); }
      const dn = row.device_name.toLowerCase();
      for (const h of ["food", "general", "glass", "mixed", "recycling"]) if (dn.includes(h) && text.includes(h)) { score += 30; reasons.push(h + " match"); }
    } else if (text.includes("consumption") || text.includes("energy") || text.includes("volume")) { score += 30; reasons.push("consumption-like parameter"); }
    if (!reasons.length) reasons.push("fallback ranking");
    return [score, reasons.join(", ")];
  }
  function parameterCandidates(parameters, row, limit) {
    const choices = [];
    for (const p of parameters) {
      const key = parameterKey(p); if (!key || !consumptionParameter(p)) continue;
      const [score, reason] = scoreParameter(row, p);
      choices.push({ key, name: textValue(p.name), units: textValue(p.units), score, reason });
    }
    choices.sort((a, b) => b.score - a.score);
    return choices.slice(0, Math.max(1, limit));
  }
  const fastParameterCandidates = row => row.utility.toUpperCase() === "ELEC"
    ? [{ key: "EACTIVE", name: "Active energy", units: "kWh", score: 100, reason: "standard electricity parameter; metadata call skipped" }] : [];
  async function fetchParameters(client, deviceId, cache) {
    if (!(deviceId in cache)) cache[deviceId] = strictListPayload(await client.get("/parameters", { device_id: deviceId, limit: 500 }));
    return cache[deviceId];
  }

  async function fetchFirstData(client, row, deviceId, candidates, startDate, endDate, resolution) {
    const errors = []; let resourceError = null;
    for (const choice of candidates) {
      try {
        const payload = await fetchReadings(client, deviceId, choice.key, startDate, endDate, resolution);
        const frame = readingsToFrame(payload);
        choice.units = payload.units || choice.units;
        if (hasUsableValues(frame)) return [choice, frame, ""];
        errors.push(choice.key + (frame.length ? ": no numeric values returned" : ": no values returned"));
      } catch (e) {
        if (!(e instanceof DexmaApiError)) throw e;
        if (e.fatal) throw e;
        resourceError = e; errors.push(choice.key + ": " + e.message);
      }
    }
    if (resourceError) throw resourceError;
    return [candidates.length ? candidates[0] : null, [], errors.join("; ")];
  }

  /* ------------------------------------------------------------------ */
  /* analysis                                                            */
  /* ------------------------------------------------------------------ */
  function baseOutcome(row, qaMode, extra) {
    return Object.assign({
      row_number: row.row_number, status: DONE, comment: "", building: row.building, device_name: row.device_name,
      device_key: row.device_key, utility: row.utility, data_source: row.data_source, qa_mode: qaMode,
      device_id: "", device_match: "", parameter_key: "", parameter_name: "", parameter_units: "",
      expected_points: null, available_points: null, availability_pct: null, zero_count: null, longest_gap_hours: null,
      current_total: null, baseline_median: null, baseline_months: null, change_vs_baseline_pct: null, peak_value: null,
      is_new_discovery: false, is_removed_device: false, check_incomplete: false, skipped_checks: "", failure_category: "",
      longest_zero_run_hours: null, peak_threshold: null, peak_method: "", peak_flagged: false, peak_flag_count: 0,
      peak_checked_count: 0, peak_total_count: 0, peak_timestamp: "", peak_limitation: ""
    }, extra || {});
  }

  function analyzeHourly(row, o) {
    const startDate = o.month, endDate = monthEnd(o.month);
    const expected = expectedHourlyPoints(startDate, endDate);
    const [actual, zeroCount] = countAvailableAndZeroes(o.readings);
    const pct = availabilityPct(actual, expected);
    const longestGap = longestMissingGapHours(o.readings, startDate, endDate);
    const zeroRun = maxZeroRunHours(o.readings);
    const peak = assessPeaks(o.readings, o.historical, o.settings.peak_multiplier);
    const issues = [];
    if (!o.readings.length) issues.push(("No hourly data returned. " + o.fetchError).trim());
    if (pct === null || pct < o.settings.availability_threshold) issues.push("Availability " + (pct || 0).toFixed(1) + "% is below the " + o.settings.availability_threshold.toFixed(1) + "% threshold.");
    if (longestGap > o.settings.max_allowed_gap_hours) issues.push("Longest missing gap is " + longestGap + " hour(s).");
    if (o.settings.zero_run_threshold_hours > 0 && zeroRun >= o.settings.zero_run_threshold_hours) issues.push("Longest consecutive zero run is " + zeroRun + " hour(s).");
    let status, comment;
    if (issues.length) { status = ISSUE; comment = "Automated QA found issue(s): " + issues.join(" "); }
    else { status = DONE; comment = "Automated QA complete: " + actual + "/" + expected + " hourly points available (" + pct.toFixed(1) + "%), no formal data-quality issues flagged."; }
    if (peak.flagged) comment += " Peak observation (not an automatic issue): " + (peak.note || (peak.count + " unusual hourly peak(s) identified for review."));
    return baseOutcome(row, "hourly", { status, comment, device_id: o.deviceId, device_match: o.deviceMatch,
      parameter_key: o.parameter.key, parameter_name: o.parameter.name, parameter_units: o.parameter.units,
      expected_points: expected, available_points: actual, availability_pct: pct, zero_count: zeroCount,
      longest_gap_hours: longestGap, peak_value: peak.value, longest_zero_run_hours: zeroRun, peak_threshold: peak.threshold,
      peak_method: peak.method, peak_flagged: peak.flagged, peak_flag_count: peak.count, peak_checked_count: peak.checked,
      peak_total_count: peak.total, peak_timestamp: peak.timestamp, peak_limitation: peak.limitation,
      check_incomplete: !!peak.limitation, skipped_checks: peak.limitation });
  }

  function analyzeMonthly(row, o) {
    const currentTotal = sumValues(o.current);
    const baselineVals = o.baseline.filter(r => r.value !== null).map(r => r.value);
    const priorYear = baselineVals.length ? baselineVals[0] : null;
    const change = pctChange(currentTotal, priorYear);
    const issues = [], notes = [];
    if (currentTotal === null) issues.push(("No monthly value returned for the QA month. " + o.fetchError).trim());
    if (priorYear === null) notes.push("No data available for the same month in the previous year, so year-over-year comparison was skipped.");
    else if (priorYear === 0) notes.push("Year-over-year percentage is undefined because the previous-year value is zero.");
    else if (change !== null && Math.abs(change) >= o.settings.monthly_change_threshold)
      issues.push("Current month shows a " + Math.abs(change).toFixed(1) + "% " + (change > 0 ? "increase" : "decrease") + " versus the same month in the previous year.");
    let status, comment;
    const ctx = o.contextNote || "";
    if (issues.length) { status = ISSUE; comment = "Automated QA found issue(s): " + [ctx].concat(issues, notes).filter(Boolean).join(" "); }
    else {
      status = DONE; const prefix = ctx ? ctx + " " : "";
      if (priorYear === null) comment = ("Automated QA complete: " + prefix + "current value " + displayNumber(currentTotal) + ". " + notes.filter(Boolean).join(" ")).trim();
      else if (priorYear === 0) comment = "Automated QA complete: " + prefix + "current value " + displayNumber(currentTotal) + ". " + notes.join(" ");
      else comment = "Automated QA complete: " + prefix + "current value " + displayNumber(currentTotal) + "; same month previous year " + displayNumber(priorYear) + "; change " + (change || 0).toFixed(1) + "%.";
    }
    const qaMode = o.qaMode || "monthly";
    return baseOutcome(row, qaMode, { status, comment, device_id: o.deviceId, device_match: o.deviceMatch,
      parameter_key: o.parameter.key, parameter_name: o.parameter.name, parameter_units: o.parameter.units,
      expected_points: 1, available_points: currentTotal === null ? 0 : 1, availability_pct: currentTotal === null ? 0 : 100,
      current_total: currentTotal, baseline_median: priorYear, baseline_months: priorYear === null ? 0 : 1, change_vs_baseline_pct: change,
      check_incomplete: notes.length > 0 || currentTotal === null || qaMode === "monthly_fallback",
      skipped_checks: notes.concat(qaMode === "monthly_fallback" ? ["Hourly completeness was not checked; monthly fallback was used."] : []).join(" ") });
  }

  const errorOutcome = (row, qaMode, message) => baseOutcome(row, qaMode, { status: ISSUE,
    comment: "Automated QA could not complete: " + message, check_incomplete: true, failure_category: "meter_check",
    skipped_checks: "Meter checks could not complete.", is_new_discovery: row.is_new_discovery });
  const finalizeOutcome = (row, o) => { o.device_id = o.device_id || row.discovered_device_id; return o; };

  async function fetchMonthlyOutcome(client, row, o) {
    const [curParam, curFrame, curErr] = await fetchFirstData(client, row, o.deviceId, o.candidates, o.month, monthEnd(o.month), "M");
    let baseline = [], baseErr = "";
    if (o.settings.historical_comparisons_enabled) {
      const [ps, pe] = sameMonthPreviousYear(o.month);
      const r = await fetchFirstData(client, row, o.deviceId, [curParam || o.candidates[0]], ps, pe, "M");
      baseline = r[1]; baseErr = r[2];
    }
    return analyzeMonthly(row, { deviceId: o.deviceId, deviceMatch: o.deviceMatch, parameter: curParam || o.candidates[0],
      current: curFrame, baseline, settings: o.settings, fetchError: [curErr, baseErr].filter(Boolean).join(" "),
      contextNote: o.contextNote || "", qaMode: o.qaMode || "monthly" });
  }

  async function processTrackerRow(client, row, o) {
    const qaMode = isMonthlyQa(row) ? "monthly" : "hourly";
    if (!row.device_key && !row.device_name) return finalizeOutcome(row, errorOutcome(row, qaMode, "tracker row has no device key or device name."));
    try {
      const device = o.deviceCache.by_id[row.discovered_device_id];
      const deviceMatch = device ? "Device discovered directly from this token by API ID." : "Device is missing from this run's discovery snapshot.";
      if (!device) return finalizeOutcome(row, errorOutcome(row, qaMode, deviceMatch));
      const deviceId = directId(device);
      if (!deviceId) return finalizeOutcome(row, errorOutcome(row, qaMode, "matched DEXMA device has no API id."));

      let candidates = fastParameterCandidates(row);
      if (!candidates.length) candidates = parameterCandidates(await fetchParameters(client, deviceId, o.parameterCache), row, o.settings.max_parameter_attempts);
      if (!candidates.length) return finalizeOutcome(row, errorOutcome(row, qaMode, "No supported consumption parameter was found. Review meter classification; environmental sensors are not consumption meters."));

      const common = { deviceId, deviceMatch, candidates, month: o.month, settings: o.settings };
      if (qaMode === "monthly") return finalizeOutcome(row, await fetchMonthlyOutcome(client, row, common));

      const [parameter, hourly, fetchError] = await fetchFirstData(client, row, deviceId, candidates, o.month, monthEnd(o.month), "H");
      if (!hasUsableValues(hourly)) {
        return finalizeOutcome(row, await fetchMonthlyOutcome(client, row, Object.assign({}, common,
          { contextNote: "Hourly data was unavailable; monthly usage fallback was used.", qaMode: "monthly_fallback" })));
      }
      let historical = [];
      if (o.settings.peak_history_enabled) {
        const [hs, he] = previous12MonthRange(o.month);
        historical = (await fetchFirstData(client, row, deviceId, [parameter || candidates[0]], hs, he, "H"))[1];
      }
      const out = analyzeHourly(row, { deviceId, deviceMatch, parameter: parameter || candidates[0], readings: hourly,
        historical, month: o.month, settings: o.settings, fetchError });

      const currentTotal = sumValues(hourly);
      out.current_total = currentTotal;
      let prior = [];
      if (o.settings.historical_comparisons_enabled) {
        const [ps, pe] = sameMonthPreviousYear(o.month);
        prior = (await fetchFirstData(client, row, deviceId, [parameter || candidates[0]], ps, pe, "M"))[1];
      }
      const priorVals = prior.filter(r => r.value !== null).map(r => r.value);
      const priorYear = priorVals.length ? priorVals[0] : null;
      const yoy = pctChange(currentTotal, priorYear);
      out.baseline_median = priorYear; out.change_vs_baseline_pct = yoy; out.baseline_months = priorYear === null ? 0 : 1;
      if (priorYear === null || priorYear === 0) {
        const note = priorYear === null ? "Year-over-year comparison skipped: same month last year has no usable value."
          : "Year-over-year percentage is undefined: previous-year value is zero.";
        out.check_incomplete = true; out.skipped_checks = [out.skipped_checks, note].filter(Boolean).join(" "); out.comment += " " + note;
      }
      if (priorYear !== null && yoy !== null && Math.abs(yoy) >= o.settings.monthly_change_threshold) {
        out.status = ISSUE;
        out.comment = out.comment.replace("Automated QA complete:", "Hourly data OK:") + " Year-over-year check: Monthly total shows a " +
          Math.abs(yoy).toFixed(1) + "% " + (yoy > 0 ? "increase" : "decrease") + " versus the same month in the previous year (" +
          displayNumber(currentTotal) + " vs " + displayNumber(priorYear) + ").";
      }
      return finalizeOutcome(row, out);
    } catch (e) {
      if (!(e instanceof DexmaApiError) || e.fatal) throw e;
      const out = errorOutcome(row, qaMode, e.message); out.failure_category = e.category;
      return finalizeOutcome(row, out);
    }
  }

  /* ------------------------------------------------------------------ */
  /* per-check verdicts                                                  */
  /* ------------------------------------------------------------------ */
  function perCheckResults(row, settings) {
    const checks = {}; CHECK_COLUMNS.forEach(n => checks[n] = ["NOT CHECKED", "Analysis was not completed for this meter."]);
    const put = (n, s, d) => checks[n] = [s, d || ""];
    if (row.status === "Not checked") return checks;
    if (row.status === "Needs review" || !row.parameter_key || row.failure_category) {
      put("Meter access / parameter", "NOT CHECKED", row.comment || "Check access and consumption parameter."); return checks;
    }
    put("Meter access / parameter", "OK");
    const mode = row.qa_mode;
    const hasCurrent = row.current_total !== null && row.current_total !== undefined && (row.available_points || 0) > 0;
    if (mode === "monthly_fallback") put("Current readings", "ISSUE", hasCurrent ? "Hourly readings unavailable; monthly fallback used." : "No hourly or monthly readings returned.");
    else put("Current readings", hasCurrent ? "OK" : "ISSUE", hasCurrent ? "" : "No usable readings for the selected month.");
    if (mode === "hourly") {
      const pct = row.availability_pct;
      if (pct !== null && pct !== undefined) put("Availability", pct >= settings.availability_threshold ? "OK" : "ISSUE",
        pct >= settings.availability_threshold ? "" : pct.toFixed(1) + "% available; minimum " + settings.availability_threshold + "%.");
      const gap = row.longest_gap_hours;
      if (gap !== null && gap !== undefined) { const f = gap > settings.max_allowed_gap_hours; put("Missing gaps", f ? "ISSUE" : "OK", f ? gap + " hours missing; allowed " + settings.max_allowed_gap_hours + " hours." : ""); }
      const zeros = row.longest_zero_run_hours, limit = settings.zero_run_threshold_hours;
      if (limit === 0) put("Consecutive zeros", "DISABLED", "Zero-run check disabled in settings.");
      else if (zeros !== null && zeros !== undefined) { const f = zeros >= limit; put("Consecutive zeros", f ? "ISSUE" : "OK", f ? zeros + " consecutive zero hours; flag at " + limit + " hours." : ""); }
      if (row.peak_flagged) put("Unusual peaks", "REVIEW", (row.peak_flag_count || 0) + " flagged hour(s) for review; strongest comparison " + displayNumber(row.peak_value) + " > " + displayNumber(row.peak_threshold) + " at " + (row.peak_timestamp || "") + ". This observation does not create a formal meter issue. " + (row.peak_limitation || ""));
      else if (!row.peak_checked_count || row.peak_limitation) put("Unusual peaks", "NOT CHECKED", row.peak_limitation || "Insufficient baseline data for peak screening.");
      else put("Unusual peaks", "OK");
    } else if (mode === "monthly") {
      put("Availability", hasCurrent ? "OK" : "ISSUE", hasCurrent ? "" : "No monthly value returned for the selected month.");
      ["Missing gaps", "Consecutive zeros", "Unusual peaks"].forEach(n => put(n, "N/A", "Monthly meter; hourly check not applicable."));
    } else {
      ["Availability", "Missing gaps", "Consecutive zeros", "Unusual peaks"].forEach(n => put(n, "NOT CHECKED", "Hourly readings unavailable; monthly totals cannot verify this check."));
    }
    const change = row.change_vs_baseline_pct, baseline = row.baseline_median;
    if (!hasCurrent) put("Year-over-year change", "NOT CHECKED", "Current-month total unavailable.");
    else if (baseline === null || baseline === undefined) put("Year-over-year change", "NOT CHECKED", "Same month last year unavailable.");
    else if (baseline === 0) put("Year-over-year change", "NOT CHECKED", "Prior-year value is zero; percentage undefined.");
    else if (change === null || change === undefined) put("Year-over-year change", "NOT CHECKED", "Comparison could not be calculated.");
    else { const f = Math.abs(change) >= settings.monthly_change_threshold; put("Year-over-year change", f ? "ISSUE" : "OK", f ? (change >= 0 ? "+" : "") + change.toFixed(1) + "% versus same month last year; threshold ±" + settings.monthly_change_threshold + "%." : ""); }
    return checks;
  }

  const formalIssueNames = (row, settings) => Object.entries(perCheckResults(row, settings))
    .filter(([n, [s]]) => s === "ISSUE" && n !== "Unusual peaks").map(([n]) => n);

  function overallResultLabel(row, settings) {
    if (row.status === "Not checked") return "Not checked";
    const checks = perCheckResults(row, settings);
    const priority = ["Meter access / parameter", "Current readings", "Availability", "Missing gaps", "Consecutive zeros", "Year-over-year change"];
    const labels = { "Meter access / parameter": "Meter access / parameter", "Current readings": "Missing current readings", "Availability": "Low availability",
      "Missing gaps": "Missing gaps", "Consecutive zeros": "Prolonged zero readings", "Unusual peaks": "Unusual peaks", "Year-over-year change": "Year-over-year change" };
    const issues = priority.filter(n => checks[n][0] === "ISSUE");
    if (issues.length) return "Issue: " + labels[issues[0]] + (issues.length > 1 ? " (+" + (issues.length - 1) + " more)" : "");
    const unchecked = priority.filter(n => checks[n][0] === "NOT CHECKED");
    if (unchecked.length) return "Not fully checked: " + (labels[unchecked[0]] || unchecked[0]);
    if (checks["Unusual peaks"][0] === "REVIEW") return "OK - With warning";
    if (checks["Unusual peaks"][0] === "NOT CHECKED") return "OK: peak check limited";
    if (priority.every(n => ["N/A", "DISABLED", "OK"].includes(checks[n][0]))) return "OK";
    return "Not fully checked";
  }

  function normalisePeakOnlyOutcome(out, settings) {
    if (out.status !== ISSUE || !out.parameter_key || out.failure_category || formalIssueNames(out, settings).length) return out;
    out.status = DONE;
    if (out.peak_flagged) {
      const avail = out.available_points || 0, exp = out.expected_points || 0, pct = out.availability_pct || 0;
      out.comment = "Automated QA complete: " + avail + "/" + exp + " hourly points available (" + pct.toFixed(1) + "%), no formal data-quality issues flagged. " +
        "Peak observation (not an automatic issue): " + out.peak_flag_count + " unusual hourly reading(s) retained for review; strongest comparison " +
        displayNumber(out.peak_value) + " > " + displayNumber(out.peak_threshold) + " at " + out.peak_timestamp + ".";
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* the run                                                             */
  /* ------------------------------------------------------------------ */
  async function runAccountQA(client, month, settings, progress) {
    const thisMonth = utcDate(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);
    if (month.getUTCDate() !== 1 || month >= thisMonth) throw new Error("Choose a completed calendar month.");
    const discovered = await fetchAccountDevices(client);
    const ignored = [], locationCandidates = [];
    for (const d of discovered) (isIgnoredDevice(d) ? ignored : locationCandidates).push(d);
    const resolved = await resolveDeviceLocationNames(client, locationCandidates);
    const devices = [];
    for (const d of locationCandidates) (isIgnoredDevice(d) ? ignored : devices).push(d);
    const cache = { by_id: {} }; devices.forEach(d => cache.by_id[directId(d)] = d);
    const parameters = {}, results = []; let failure = "";
    for (let i = 0; i < devices.length; i++) {
      const row = trackerRowFromDevice(devices[i], i + 1, "Location not supplied");
      if (progress) progress(i, devices.length, row.device_name);
      let out;
      try { out = await processTrackerRow(client, row, { month, settings, deviceCache: cache, parameterCache: parameters }); }
      catch (e) { if (e instanceof DexmaApiError && e.fatal) { failure = e.message; break; } throw e; }
      out.device_id = directId(devices[i]);
      if (!out.parameter_key || out.failure_category) { out.status = "Needs review"; out.check_incomplete = true; }
      else if (out.qa_mode === "monthly_fallback") { out.status = ISSUE; out.comment = "Hourly readings are unavailable for this automated meter. " + out.comment; }
      results.push(normalisePeakOnlyOutcome(out, settings));
      if (progress) progress(i + 1, devices.length, row.device_name);
    }
    const isG = d => hasDeviceKeyPrefix(d, GROUP_KEY_PREFIXES), isDD = d => hasDeviceKeyPrefix(d, DD_KEY_PREFIXES);
    return { results, device_count: devices.length, discovered_count: discovered.length, ignored_count: ignored.length,
      ignored_group_count: ignored.filter(isG).length, ignored_dd_count: ignored.filter(isDD).length,
      ignored_retired_count: ignored.filter(d => !isG(d) && !isDD(d)).length,
      ignored_devices: ignored.map(d => ({ device_id: directId(d), device_key: deviceLocalId(d), device_name: deviceName(d), location: deviceLocationName(d), reason: ignoredDeviceReason(d) })),
      resolved_location_count: Object.keys(resolved).length, checked_count: results.length,
      complete: !failure, failure, month: isoDate(month), settings: Object.assign({}, settings),
      created_at: new Date().toISOString(), request_count: client.callLog.length,
      scope: devices.map(d => ({ device_id: directId(d), device_key: deviceLocalId(d), device_name: deviceName(d), building: deviceLocationName(d) || "Location not supplied" })) };
  }

  /* ------------------------------------------------------------------ */
  /* drafts                                                              */
  /* ------------------------------------------------------------------ */
  async function fingerprint(deviceId, month) {
    const data = new TextEncoder().encode(deviceId + "|" + month);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  }

  /* One line per finding, with the number that matters in it. "Consumption
     change" says nothing; "Consumption up 200% vs same month last year" is
     the whole issue. Order matches the tags so the first headline pairs with
     the first tag. */
  function findingHeadlines(row, settings) {
    const out = [];
    const av = row.availability_pct, ch = row.change_vs_baseline_pct;
    if (row.qa_mode === "monthly_fallback") out.push("No hourly readings \u2014 monthly total used instead");
    else if ((row.current_total === null || row.current_total === undefined) && (row.available_points || 0) === 0) out.push("No readings returned for the month");
    if (row.qa_mode === "hourly") {
      if (av !== null && av !== undefined && av < settings.availability_threshold) out.push("Availability " + av.toFixed(0) + "% (minimum " + settings.availability_threshold + "%)");
      if ((row.longest_gap_hours || 0) > settings.max_allowed_gap_hours) out.push("Missing gap of " + row.longest_gap_hours + " hours");
      if (settings.zero_run_threshold_hours > 0 && (row.longest_zero_run_hours || 0) >= settings.zero_run_threshold_hours) out.push("Zero readings for " + row.longest_zero_run_hours + " consecutive hours");
    }
    if (ch !== null && ch !== undefined && Math.abs(ch) >= settings.monthly_change_threshold)
      out.push("Consumption " + (ch > 0 ? "up" : "down") + " " + Math.abs(ch).toFixed(0) + "% vs same month last year");
    if (!out.length) out.push("Meter data review");
    return out;
  }

  async function issueDraft(row, month, settings) {
    const tags = [], actions = [];
    const headlines = findingHeadlines(row, settings);
    const availability = row.availability_pct;
    if (row.qa_mode === "monthly_fallback") { tags.push("Missing hourly readings"); actions.push("Check the hourly feed and expected reading frequency; monthly totals do not establish hourly completeness."); }
    else if ((row.current_total === null || row.current_total === undefined) && (row.available_points || 0) === 0) { tags.push("Missing readings"); actions.push("Check the meter connection or manual reading submission and recover missing readings."); }
    if (row.qa_mode === "hourly") {
      if (availability !== null && availability !== undefined && availability < settings.availability_threshold) { tags.push("Low data availability"); actions.push("Check gateway communications and backfill missing data where available."); }
      if ((row.longest_gap_hours || 0) > settings.max_allowed_gap_hours) { tags.push("Reading gaps"); actions.push("Review the missing intervals against gateway and meter logs."); }
      if (settings.zero_run_threshold_hours > 0 && (row.longest_zero_run_hours || 0) >= settings.zero_run_threshold_hours) { tags.push("Prolonged zero readings"); actions.push("Confirm whether the zero run reflects occupancy or shutdown; otherwise inspect the meter feed."); }
    }
    const change = row.change_vs_baseline_pct;
    if (change !== null && change !== undefined && Math.abs(change) >= settings.monthly_change_threshold) { tags.push("Consumption change"); actions.push("Compare with the same month last year; check occupancy, weather, operations and meter coverage."); }
    if (!tags.length) { tags.push("Meter data review"); actions.push("Review the evidence and confirm whether a data correction or site investigation is required."); }
    const priority = (availability !== null && availability !== undefined && availability < 50) ? "High" : "Medium";
    const monthText = parseDateOnly(month).toLocaleDateString("en-IE", { month: "long", year: "numeric", timeZone: "UTC" });
    const ref = await fingerprint(row.device_id, month);
    const evidence = [
      "Location: " + row.building, "Meter: " + row.device_name,
      "Device key: " + row.device_key + " | DEXMA ID: " + row.device_id,
      "Month: " + monthText + " | Utility: " + (row.utility || "Confirm utility"),
      "Parameter: " + (row.parameter_key || "") + " | Units: " + (row.parameter_units || "Not supplied"),
      "Check mode: " + row.qa_mode,
      "Availability: " + displayNumber(availability, "%") + " (" + row.available_points + " / " + row.expected_points + " points)",
      "Longest missing gap: " + displayNumber(row.longest_gap_hours, " hours"),
      "Longest zero run: " + displayNumber(row.longest_zero_run_hours, " hours"),
      "Current total: " + displayNumber(row.current_total),
      "Same month last year: " + displayNumber(row.baseline_median),
      "Year-over-year change: " + displayNumber(change, "%"),
      "Peak screening: " + (row.peak_flag_count || 0) + " flagged hour(s); strongest comparison " + displayNumber(row.peak_value) + " against " + displayNumber(row.peak_threshold) + " at " + (row.peak_timestamp || "N/A") + " | Method: " + (row.peak_method || "Not evaluated")
    ].join("\n");
    const uniqueActions = Array.from(new Set(actions));
    const description = "Findings\n" + row.comment + "\n\nEvidence\n" + evidence +
      "\n\nSuggested next steps\n" + uniqueActions.map(a => "- " + a).join("\n") +
      "\n\nCheck limitations\n" + (row.skipped_checks || "No skipped checks reported.") +
      "\nHourly checks use a nominal 24-hour calendar day; review daylight-saving transitions and the meter timezone." +
      "\n\nDraft reference: " + ref;
    const shortMonth = parseDateOnly(month).toLocaleDateString("en-IE", { month: "short", year: "numeric", timeZone: "UTC" });
    const title = row.device_name + " \u2014 " + headlines[0] + (headlines.length > 1 ? " (+" + (headlines.length - 1) + " more)" : "") + " \u2014 " + shortMonth;
    return { reference: ref, title, headlines, suggested_priority: priority,
      findings: tags.join(", "), location: row.building, meter: row.device_name, device_key: row.device_key,
      device_id: row.device_id, month: month.slice(0, 7), description };
  }

  async function draftsForBundle(bundle) {
    const out = [];
    for (const r of bundle.results) if (formalIssueNames(r, bundle.settings).length) out.push(await issueDraft(r, bundle.month, bundle.settings));
    return out;
  }

  function exportRows(bundle) {
    const rows = bundle.results.slice();
    const checked = new Set(rows.map(r => String(r.device_id)));
    for (const m of (bundle.scope || [])) {
      if (!checked.has(String(m.device_id)))
        rows.push(Object.assign({}, m, { status: "Not checked", qa_mode: "", comment: "Run stopped before this meter was checked.", skipped_checks: bundle.failure || "" }));
    }
    return rows;
  }

  window.SavIQ = { DexmaClient, DexmaApiError, DEFAULT_SETTINGS, CHECK_COLUMNS, runAccountQA, draftsForBundle, exportRows, findingHeadlines,
    issueDraft, perCheckResults, overallResultLabel, formalIssueNames, addMonths, monthEnd, utcDate, isoDate, displayNumber };
})();
