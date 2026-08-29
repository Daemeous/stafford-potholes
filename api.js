/* ============================================================================
   api.js — Backend abstraction for the Pothole Watch app.

   This is the ONLY file that knows how reports/clusters are actually stored
   and how writes actually get there. core.js calls nothing but the functions
   below — it never builds a CSV URL or an Apps Script payload itself. That
   split exists for one reason: this is a proof-of-concept built on Google
   Sheets + Apps Script (same zero-hosting-cost pattern as ../Leaflet App/),
   but the intended end state is a council-hosted backend with a real
   database. When that day comes, only this file's *internals* need to
   change — every function signature and every caller in core.js stays the
   same. Do not let core.js reach around this file to fetch a Sheet/Script
   URL directly, or that swap stops being a one-file change.

   Today's implementation:
     - fetchReports() / fetchClusters()  -> GET the Sheet's published CSVs
     - submitReport() / verify() / updateReportStatus() / updateCluster()
                                          -> POST JSON to the Apps Script
                                             web app URL (APPS_SCRIPT_URL)

   Report object shape returned by fetchReports():
     { id, timestamp, lat, lon, accuracy, description, severity,
       photoUrl, status, clusterId, roadName, ward, plannedDate, _rowIdx }

   Cluster object shape returned by fetchClusters():
     { clusterId, roadName, ward, centroidLat, centroidLon, reportCount,
       priorityScore, priorityRank, status, plannedDate, notes, _rowIdx }
   ============================================================================ */

(function () {
  const CFG = window.POTHOLE_CONFIG || {};
  if (!CFG.SHEET_ID) {
    console.error("POTHOLE_CONFIG missing — define window.POTHOLE_CONFIG before loading api.js");
    return;
  }

  const SHEET_ID     = CFG.SHEET_ID;
  const REPORTS_URL  = `https://docs.google.com/spreadsheets/d/e/${SHEET_ID}/pub?gid=${CFG.REPORTS_GID}&single=true&output=csv`;
  const CLUSTERS_URL = `https://docs.google.com/spreadsheets/d/e/${SHEET_ID}/pub?gid=${CFG.CLUSTERS_GID}&single=true&output=csv`;
  const APPS_SCRIPT_URL = CFG.APPS_SCRIPT_URL;

  // ── CSV fetch/parse (same cache-busting + PapaParse pattern as the
  // leafletting map's fetchCSVText/parseCSVRows) ──────────────────────────
  async function fetchCSVText(url) {
    const sep = url.includes("?") ? "&" : "?";
    const res = await fetch(url + sep + "cachebust=" + Date.now(), { credentials: "omit", cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.text();
  }
  function parseCSVRows(text) {
    return new Promise(resolve => { Papa.parse(text, { header: true, skipEmptyLines: true, complete: r => resolve(r.data) }); });
  }

  function toReport(row, i) {
    return {
      _rowIdx: i + 2, // sheet row number — same "row position is identity" convention as the leafletting map
      id: row.id || "",
      timestamp: row.timestamp || "",
      lat: parseFloat(row.lat),
      lon: parseFloat(row.lon),
      accuracy: parseFloat(row.accuracy) || null,
      description: row.description || "",
      severity: row.severity || "Unknown",
      photoUrl: row.photo_url || "",
      status: row.status || "Reported",
      clusterId: row.cluster_id || "",
      roadName: row.road_name || "",
      ward: row.ward || "",
      plannedDate: row.planned_date || "",
    };
  }

  function toCluster(row, i) {
    return {
      _rowIdx: i + 2,
      clusterId: row.cluster_id || "",
      roadName: row.road_name || "",
      ward: row.ward || "",
      centroidLat: parseFloat(row.centroid_lat),
      centroidLon: parseFloat(row.centroid_lon),
      reportCount: parseInt(row.report_count, 10) || 0,
      priorityScore: parseFloat(row.priority_score) || 0,
      priorityRank: parseInt(row.priority_rank, 10) || null,
      status: row.status || "Under_Review",
      plannedDate: row.planned_date || "",
      notes: row.notes || "",
    };
  }

  async function fetchReports() {
    const text = await fetchCSVText(REPORTS_URL);
    const rows = await parseCSVRows(text);
    return rows.filter(r => r.id && r.lat && r.lon).map(toReport);
  }

  async function fetchClusters() {
    if (!CFG.CLUSTERS_GID) return [];
    const text = await fetchCSVText(CLUSTERS_URL);
    const rows = await parseCSVRows(text);
    return rows.filter(r => r.cluster_id).map(toCluster);
  }

  // ── Photo downscale/compress before upload — keeps the Apps Script POST
  // payload small (Apps Script/UrlFetch have practical payload limits, and
  // a phone photo straight off the camera is typically several MB). ───────
  const MAX_PHOTO_DIMENSION = 1600;
  const PHOTO_JPEG_QUALITY = 0.75;
  function downscalePhoto(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width, height } = img;
        const scale = Math.min(1, MAX_PHOTO_DIMENSION / Math.max(width, height));
        width = Math.round(width * scale);
        height = Math.round(height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", PHOTO_JPEG_QUALITY);
        resolve({ base64: dataUrl.split(",")[1], mimeType: "image/jpeg" });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read photo.")); };
      img.src = url;
    });
  }

  async function postAction(payload) {
    const res = await fetch(APPS_SCRIPT_URL, { method: "POST", body: JSON.stringify(payload) });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Request failed.");
    return data;
  }

  // photoFile: a File from an <input type=file>, or null if no photo yet
  // (the form should require one, but the API itself doesn't enforce that).
  async function submitReport({ lat, lon, accuracy, description, severity, photoFile }) {
    let photo = null;
    if (photoFile) photo = await downscalePhoto(photoFile);
    return postAction({
      action: "submitReport",
      lat, lon, accuracy, description, severity,
      photoBase64: photo ? photo.base64 : null,
      photoMimeType: photo ? photo.mimeType : null,
    });
  }

  async function verify(idToken, accessToken, emailHint) {
    const payload = idToken ? { action: "verify", idToken } : { action: "verify", accessToken, email: emailHint };
    return postAction(payload);
  }

  // authTp: { idToken } or { accessToken } — same token-shape convention as
  // the leafletting map's `tp` spread used on every authenticated call.
  async function updateReportStatus({ rowIdx, status, plannedDate }, authTp) {
    return postAction({ action: "updateReportStatus", rowIndex: rowIdx, status, plannedDate, ...authTp });
  }

  async function updateCluster({ rowIdx, status, plannedDate }, authTp) {
    return postAction({ action: "updateCluster", rowIndex: rowIdx, status, plannedDate, ...authTp });
  }

  window.PotholeAPI = { fetchReports, fetchClusters, submitReport, verify, updateReportStatus, updateCluster };
})();
