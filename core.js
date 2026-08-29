/* ============================================================================
   core.js — Stafford Pothole Watch app code.

   Forked from ../Leaflet App/core.js — reuses that app's PWA shell
   injection, GPS-fix pattern, and Google Sign-In flow verbatim (see the
   comments marking each borrowed block), but replaces the road-status
   tracking logic with pothole reporting: GPS+photo report submission, a
   public map of reports coloured by status, prioritised repair-section
   overlays from the clustering batch job, and an auth-gated admin panel
   for setting statuses/plans.

   index.html defines window.POTHOLE_CONFIG before loading this file (see
   that file's header comment for the expected shape). All reads/writes go
   through window.PotholeAPI (api.js) — this file never fetches a Sheet CSV
   or posts to Apps Script directly, so the backend can be swapped later
   without touching anything below.
   ============================================================================ */

(function () {
  const CFG = window.POTHOLE_CONFIG || {};
  if (!CFG.SHEET_ID) {
    console.error("POTHOLE_CONFIG missing — define window.POTHOLE_CONFIG before loading core.js");
    return;
  }
  if (!window.PotholeAPI) {
    console.error("api.js must be loaded before core.js");
    return;
  }

  const GOOGLE_CLIENT_ID = CFG.GOOGLE_CLIENT_ID;
  const LS_SUFFIX = CFG.LS_SUFFIX || "pothole";
  const LS_AUTH   = `pothole_auth_v1_${LS_SUFFIX}`;
  const LS_COOKIE = `pothole_cookie_consent_${LS_SUFFIX}`;
  const INITIAL_VIEW = CFG.INITIAL_VIEW || [52.8, -2.12];
  const INITIAL_ZOOM = CFG.INITIAL_ZOOM || 12;
  const DISABLE_AUTH_CHECK = CFG.DISABLE_AUTH_CHECK === true;
  const POLL_INTERVAL_MS = CFG.POLL_INTERVAL_MS || 5 * 60 * 1000;

  // ── Status definitions ───────────────────────────────────────────────────
  const STATUSES = [
    { key: "reported",    sheetValue: "Reported",     label: "Reported",     colour: "#f75f5f" },
    { key: "underreview", sheetValue: "Under_Review",  label: "Under Review",  colour: "#f5c842" },
    { key: "planned",     sheetValue: "Planned",       label: "Planned",      colour: "#4f8ef7" },
    { key: "scheduled",   sheetValue: "Scheduled",     label: "Scheduled",    colour: "#a78bfa" },
    { key: "fixed",       sheetValue: "Fixed",         label: "Fixed",        colour: "#3ecf6e" },
  ];
  function getStatus(v) {
    const norm = (v || "").trim().toLowerCase().replace(/[\s_]+/g, "");
    return STATUSES.find(s => s.sheetValue.toLowerCase().replace(/_/g, "") === norm) || STATUSES[0];
  }
  function statusKey(v) { return getStatus(v).key; }
  function colourFor(v) { return getStatus(v).colour; }

  const SEVERITIES = ["Minor", "Moderate", "Severe", "Hazardous"];

  function escHtml(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

  // ── DOM injection ─────────────────────────────────────────────────────────
  function buildStatusToggles() {
    return STATUSES.map(s => `<button class="status-toggle active s-${s.key}" data-status="${s.key}" onclick="toggleStatus(this)"><span class="status-dot" style="background:${s.colour};box-shadow:0 0 6px ${s.colour}"></span>${escHtml(s.label)}<span class="toggle-count" id="cnt-${s.key}">0</span></button>`).join("");
  }
  function buildStatsTop() {
    return STATUSES.map(s => `<div class="stat"><div class="stat-num" style="color:${s.colour}" id="stat-${s.key}">0</div><div class="stat-label">${escHtml(s.label)}</div></div>`).join("");
  }

  // ── PWA: manifest, iOS meta tags, service worker ─────────────────────────
  // Borrowed verbatim from ../Leaflet App/core.js's injectPwaHead() — same
  // reasoning applies here (blob: manifest URL needs an absolute base;
  // icons inlined so there's no icons/ folder to keep in sync). Placeholder
  // icons reused as-is for the PoC — swap for a pothole/road icon before any
  // real public launch.
  const PWA_ICON_192 = "iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAYAAABS3GwHAAADUklEQVR42u3dwW3jQBBEUWZg+OSwnJnT9VFKQSB7yOmuR+AnINabkQGv9/j6/nlJqR0+BAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABMK8zj88NgIihgwGAsUMBgNHDAIDRwwCA4YMAgOGDAIDhgwBA4+H//v1fDgQAWgy/YuxPoQDA8Lce/F0gADD+NqNfhQEAw285fBAAKB9/x+FXQgAgdPwThl8FAYCg8U8cfgUEAAwfhIEQDuPPHD8EAwEY/n0QADB+CAAwfggAaDN+A18DAQDjhwCAfQEY83oEABg/BAAYPwQAGD8EABg/BAA8AMBI90AAgNPfLQCA8UMAgK8+vgoBYPwQAAAAAAAYPwQAlAAwvj4IAHD6uwUAcPq7BQBw+rsFAHD6uwUAcPq7BQBw+rsFAHD6uwUAMH63AAAAAJAIwPghAAAAAAAAAIAwAMYPAQAAAAAAAAAAAAAAABh/BoJ4AE5/twAAAAAAAAAAAAAAAAAYvx+EAQAAgOkAfP0B4GkEAAgAAAQAAAIAAAEAgAAAQAAAIAAAEAAACAAABAAAAgAAAeC3QeW3QQEQAL4Gyb8IA0AAACAAABAAfhCWvwznFjB+fxsUAAAAAAAAAAAAAAAIjN//EQYAAAAAAAAAEBg/AAAAAMDrk8e4+o8fALeA0x8At4DTHwC3gNMfALeA0x8At4DTHwC3gNMfALeA0x8At4DTPx4ABMYPAAAAJAOAwPgB+PAxyr3GDwAExg+Ar0K++gDgFnD6AwCB8QMAgfEDAIHxAwCB8QNwBwAI1o4fAAiMH4AeCECoG3738Y8BAIHxxwOAwPjjAZxBkA7hzDNpL+MAQGD88QBAMHwALiCYCuHsM3kf4wFcQTAFwpVn+jYiAFxF0BXC1SdhFzEAkiAYPgBLEeyIoepJ20IkgGoIT4CoflI3EA1gFYRqFCuf9HcPwE0Qdnu8bwAiIXi/AERC8D4BiITg/QEQh8F7AiAOg/cBQAwKnzMAETB8bgBIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAAgAH4IAkACQAJAAkACQAJAAkACQAJBm9QZjxVBqEAz9WgAAAABJRU5ErkJggg==";
  const PWA_ICON_512 = "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAYAAAD0eNT6AAAM2UlEQVR42u3dwVEjQRBFQXlAcMIsPMNdjmDDXNRd9bIj0gE2dv6blth9fXx+/QEALS8/BAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAADwwD8vWCH6cpAS1QAAAABJRU5ErkJggg==";
  const PWA_APPLE_ICON = "iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAYAAAA9zQYyAAADAklEQVR42u3d0U3EMBBF0e0A8UVZdEa7fILogMROMvPmWLoN2EcjZ1ebfb29f/xIKb1sgoCWgJaAloAW0BLQEtAS0BLQAloCWgJaAloCWkBLQEtAS0BXbP/LPsEdCuwq8s+A90aMOBAxyOGG+hYxHADHQ0ZbKAjIYMN9O3IPr++wQa6PuQ/qLsDG+jbIF8B+C7gQMP8GOKrcAM9FHIlxFfgBnoI5g6Qd8EGOhhzR8g7YAMNMthA18OcCHkVNtAwQw30c5gnQV6BDTTMUAMNM9RAH8IM8DpsoGGGGmiYoQYa5htRAw0z1EDDDHU4aJihBlpAw6wE1C+YlYS6LWjonkcNtOlsSgMNsyndGDTMUAMtoCuChhlqoAV0RdAwQw20gK4IGmaogRbQHUFD1Av1eNCmsykNtIDuCBoe145WoE1nUxpoAd0RNDSuHUALaNcNJV07gBbQrhuqeu0AWkADLaCBBhpoAQ20gPaRnTI+ugNaQAMtoIEGeiJoSDwYmtAyoYEW0EALaKCB9k2hPBACLaCBFtBAC2iggQZaQPvVt/zqG2gB7doBtDcnAQ20t4/KdQNoAe3aIW/wN6VhBhpooP1PoVw3/JOsxkxnoAU01DBXxQy0gIYa5qqYgRbQUMNcFTPQAhpqmKtibgsa6hqYgTalTWegoTadA0BDDXMcaKhhBlpAQ60EzG1AQw1zHGioYR4JGur9mIGGGmagoYZ5KOgjqME+B7kj5tagoYY5DjTUMMeBPop6Guyjq7uFCNBQwxwH+gzqVNhnVoqBKNDTYU+GHA36LOqusM+uxHOPBb2CugvslZV65tGgd8Cuhnt1pZ/1CNA7UD+Je9eacM5jQO+GfSXw3WvS+Y4DfRXs/8C/e00817Ggn4INMtBggwz0JNjODej2uJ0P0O1xOwegWwO3z0C3Am+fgJaAFtAS0BLQEtAS0AJaAloCWgJaAlpAS0BLQEtAS0ALaAloCWgJaAloAS0BLQEtAS2gJaClev0CJHNfV+3/t+EAAAAASUVORK5CYII=";

  function injectPwaHead() {
    const baseUrl = new URL("./", document.location.href).href;
    const manifest = {
      name: CFG.TITLE || "Pothole Watch",
      short_name: (CFG.TITLE || "Pothole Watch").slice(0, 24),
      description: CFG.SUBTITLE || "Report and track potholes.",
      start_url: baseUrl, scope: baseUrl, display: "standalone",
      background_color: "#0f1117", theme_color: "#0f1117",
      icons: [
        { src: `data:image/png;base64,${PWA_ICON_192}`, sizes: "192x192", type: "image/png" },
        { src: `data:image/png;base64,${PWA_ICON_512}`, sizes: "512x512", type: "image/png" }
      ]
    };
    const blob = new Blob([JSON.stringify(manifest)], { type: "application/manifest+json" });
    const manifestLink = document.createElement("link");
    manifestLink.rel = "manifest"; manifestLink.href = URL.createObjectURL(blob);
    document.head.appendChild(manifestLink);

    const themeColor = document.createElement("meta");
    themeColor.name = "theme-color"; themeColor.content = "#0f1117";
    document.head.appendChild(themeColor);

    const appleIcon = document.createElement("link");
    appleIcon.rel = "apple-touch-icon"; appleIcon.href = `data:image/png;base64,${PWA_APPLE_ICON}`;
    document.head.appendChild(appleIcon);

    [["apple-mobile-web-app-capable", "yes"],
     ["apple-mobile-web-app-status-bar-style", "black-translucent"],
     ["apple-mobile-web-app-title", CFG.TITLE || "Pothole Watch"]].forEach(([name, content]) => {
      const m = document.createElement("meta"); m.name = name; m.content = content; document.head.appendChild(m);
    });

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => {}); });
    }
  }

  function injectAppShell() {
    document.title = CFG.TITLE || "Pothole Watch";
    const app = document.createElement("div");
    app.id = "app";
    app.innerHTML = `
  <aside id="sidebar">
    <div class="sidebar-head">
      <h1>${escHtml(CFG.TITLE || "Pothole Watch")}</h1>
      <p>${escHtml(CFG.SUBTITLE || "Report a pothole with your location and a photo.")}</p>
      <button id="report-btn" class="report-btn" onclick="startReportFlow()">📍 Report a pothole</button>
      <div id="sync-bar" title="Click to check for updates" onclick="manualRefresh()">
        <div id="sync-left"><div id="sync-dot"></div><span id="sync-text">Loading…</span></div>
        <span id="sync-icon">↻</span>
      </div>
    </div>
    <div id="stats"><div id="stats-top">${buildStatsTop()}</div></div>
    <div class="sidebar-scroll">
      <div class="filter-section">
        <div class="filter-label">Status</div>
        <div class="status-toggles">${buildStatusToggles()}</div>
      </div>
      <div class="filter-section">
        <div class="filter-label">Priority repair sections</div>
        <button class="ward-all-btn" id="clusters-toggle-btn" onclick="toggleClusterOverlay()">Show prioritised sections</button>
        <div id="cluster-list"></div>
      </div>
      <div class="filter-section" id="admin-section" style="display:none;margin-top:auto;">
        <div class="filter-label">Admin</div>
        <div class="popup-auth-msg" id="admin-whoami"></div>
      </div>
      <div class="filter-section">
        <button class="ward-all-btn" id="signin-btn" onclick="triggerSignIn()">Council staff sign in</button>
      </div>
    </div>
  </aside>
  <div id="map-wrap">
    <button id="sidebar-toggle" onclick="toggleSidebar(event)">☰</button>
    <div id="map"></div>
    <div id="loading"><div class="spinner"></div><p id="loading-msg">Loading reports…</p></div>
    <div id="error-banner"></div>
    <div id="report-modal-overlay" style="display:none;"></div>
  </div>`;
    document.body.insertBefore(app, document.body.firstChild);

    const cookieBanner = document.createElement("div");
    cookieBanner.id = "cookie-banner"; cookieBanner.className = "hidden";
    cookieBanner.innerHTML = `
  <p>This site can store a cookie to remember your Google sign-in between visits (council staff only — reporting a pothole never requires signing in).</p>
  <button class="cookie-btn cookie-btn-decline" onclick="cookieDecline()">Decline</button>
  <button class="cookie-btn cookie-btn-accept"  onclick="cookieAccept()">Accept &amp; remember me</button>`;
    document.body.appendChild(cookieBanner);
  }

  injectAppShell();
  injectPwaHead();

  L.DomEvent.disableClickPropagation(document.getElementById("sidebar"));
  L.DomEvent.disableClickPropagation(document.getElementById("sidebar-toggle"));

  // ── Map ───────────────────────────────────────────────────────────────────
  const map = L.map("map", { zoomControl: false }).setView(INITIAL_VIEW, INITIAL_ZOOM);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>', maxZoom: 19
  }).addTo(map);
  L.control.zoom({ position: "bottomright" }).addTo(map);

  // ── State ─────────────────────────────────────────────────────────────────
  let allReports = [];
  let allClusters = [];
  let reportMarkers = new Map(); // _rowIdx -> L.circleMarker
  let clusterLayerGroup = L.layerGroup();
  let clustersVisible = false;
  let activeStatus = new Set(STATUSES.map(s => s.key));
  let pollTimer = null, isChecking = false;
  let authToken = null, authTokenType = "idToken", authEmail = null, authExpiry = 0, authAuthorised = false, authBanned = false;
  let pendingReportLocation = null; // {lat, lon, accuracy} captured for the in-progress report form

  // ── Cookie consent ───────────────────────────────────────────────────────
  function cookieConsent() { return localStorage.getItem(LS_COOKIE); }
  function showCookieBanner() { if (!cookieConsent()) document.getElementById("cookie-banner").classList.remove("hidden"); }
  function cookieAccept() { localStorage.setItem(LS_COOKIE, "accepted"); document.getElementById("cookie-banner").classList.add("hidden"); persistAuthSession(); }
  function cookieDecline() { localStorage.setItem(LS_COOKIE, "declined"); document.getElementById("cookie-banner").classList.add("hidden"); localStorage.removeItem(LS_AUTH); }

  // ── Auth persistence ─────────────────────────────────────────────────────
  function persistAuthSession() {
    if (cookieConsent() !== "accepted" || !authToken || !authEmail || authBanned) return;
    try { localStorage.setItem(LS_AUTH, JSON.stringify({ token: authToken, tokenType: authTokenType, email: authEmail, expiry: authExpiry, authorised: authAuthorised, banned: authBanned })); } catch (e) {}
  }
  function restoreAuthSession() {
    if (cookieConsent() !== "accepted") return;
    try {
      const raw = localStorage.getItem(LS_AUTH); if (!raw) return;
      const s = JSON.parse(raw);
      if (!s.token || Date.now() >= s.expiry - 30_000) { localStorage.removeItem(LS_AUTH); return; }
      authToken = s.token; authTokenType = s.tokenType || "idToken"; authEmail = s.email; authExpiry = s.expiry;
      authAuthorised = DISABLE_AUTH_CHECK ? true : s.authorised;
      authBanned = DISABLE_AUTH_CHECK ? false : (s.banned === true);
      if (authAuthorised && !authBanned) showAdminUI();
    } catch (e) { localStorage.removeItem(LS_AUTH); }
  }
  function authTp() { return authTokenType === "idToken" ? { idToken: authToken } : { accessToken: authToken }; }
  function tokenIsValid() { return authToken && Date.now() < authExpiry - 30_000; }
  function signOut() { authToken = null; authEmail = null; authAuthorised = false; localStorage.removeItem(LS_AUTH); document.getElementById("admin-section").style.display = "none"; document.getElementById("signin-btn").style.display = ""; }
  function showAdminUI() {
    document.getElementById("admin-section").style.display = "";
    document.getElementById("admin-whoami").innerHTML = `✓ ${escHtml(authEmail)} <button class="popup-signout-link" onclick="signOut()">↩ sign out</button>`;
    document.getElementById("signin-btn").style.display = "none";
  }

  // ── Google Sign-In ───────────────────────────────────────────────────────
  // Borrowed verbatim from ../Leaflet App/core.js's triggerSignIn/
  // onGoogleSignIn/useOAuthPopupFallback/processSignIn — same One Tap ->
  // OAuth-popup-fallback flow, same idToken/accessToken token-shape
  // convention, just calling PotholeAPI.verify() instead of a raw fetch.
  function triggerSignIn() {
    if (typeof google === "undefined" || !google.accounts) { showError("Google Sign-In not loaded."); return; }
    google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: onGoogleSignIn, auto_select: true, cancel_on_tap_outside: false });
    google.accounts.id.prompt(n => { if (n.isNotDisplayed() || n.isSkippedMoment()) useOAuthPopupFallback(); });
  }
  function useOAuthPopupFallback() {
    google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID, scope: "openid email profile",
      callback: async tr => {
        if (tr.error) { showError("Sign-in failed: " + tr.error); return; }
        try {
          const info = await (await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: "Bearer " + tr.access_token } })).json();
          await processSignIn(null, info.email, tr.access_token);
        } catch (e) { showError("Sign-in error: " + e.message); }
      }
    }).requestAccessToken({ prompt: "select_account" });
  }
  async function onGoogleSignIn(response) { await processSignIn(response.credential, null, null); }
  async function processSignIn(idToken, emailHint, accessToken) {
    try {
      const data = await PotholeAPI.verify(idToken, accessToken, emailHint);
      authToken = idToken || accessToken; authTokenType = idToken ? "idToken" : "accessToken";
      authEmail = data.email || emailHint; authExpiry = Date.now() + 55 * 60 * 1000;
      authAuthorised = DISABLE_AUTH_CHECK ? true : (data.authorised === true);
      authBanned = DISABLE_AUTH_CHECK ? false : (data.banned === true);
      if (authBanned) { showError("This Google account isn't permitted to make admin changes."); return; }
      if (cookieConsent() === "accepted") persistAuthSession();
      else if (!cookieConsent()) showCookieBanner();
      if (authAuthorised) showAdminUI();
      renderMarkers(); // popups now show admin controls
    } catch (e) { showError("Sign-in error: " + e.message); }
  }

  // ── GPS fix ───────────────────────────────────────────────────────────────
  // Same navigator.geolocation.getCurrentPosition call/options as
  // ../Leaflet App/core.js's locateAndFilterWard() — high accuracy, no
  // cached fix, 10s timeout, same err.code -> message mapping.
  function getCurrentLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error("Geolocation isn't supported on this device/browser.")); return; }
      navigator.geolocation.getCurrentPosition(
        pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }),
        err => {
          const msgs = { 1: "Location permission denied.", 2: "Location unavailable.", 3: "Location request timed out." };
          reject(new Error(msgs[err.code] || "Could not get your location."));
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  }

  // ── Report submission flow ──────────────────────────────────────────────
  async function startReportFlow() {
    const btn = document.getElementById("report-btn");
    btn.disabled = true; btn.textContent = "📍 Getting your location…";
    try {
      pendingReportLocation = await getCurrentLocation();
      openReportForm();
    } catch (e) {
      showError(e.message);
    } finally {
      btn.disabled = false; btn.textContent = "📍 Report a pothole";
    }
  }

  function openReportForm() {
    const overlay = document.getElementById("report-modal-overlay");
    overlay.style.display = "flex";
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-head"><h2>Report a pothole</h2><button class="modal-close" onclick="closeReportForm()">✕</button></div>
        <div class="modal-body">
          <div class="popup-auth-msg">📍 Location captured (±${Math.round(pendingReportLocation.accuracy || 0)}m accuracy). Photo is required so others can see what's been reported.</div>
          <label class="form-label">Photo</label>
          <input type="file" id="report-photo-input" accept="image/*" capture="environment">
          <img id="report-photo-preview" style="display:none;">
          <label class="form-label">Severity</label>
          <select id="report-severity-input">${SEVERITIES.map(s => `<option value="${s}">${s}</option>`).join("")}</select>
          <label class="form-label">Description (optional)</label>
          <textarea id="report-description-input" rows="3" placeholder="e.g. deep pothole in the middle of the lane, near the postbox"></textarea>
          <div id="report-form-msg" class="popup-auth-msg"></div>
          <button class="report-btn" id="report-submit-btn" onclick="submitReportForm()">Submit report</button>
        </div>
      </div>`;
    document.getElementById("report-photo-input").addEventListener("change", e => {
      const file = e.target.files[0]; const preview = document.getElementById("report-photo-preview");
      if (!file) { preview.style.display = "none"; return; }
      preview.src = URL.createObjectURL(file); preview.style.display = "block";
    });
  }
  function closeReportForm() { document.getElementById("report-modal-overlay").style.display = "none"; pendingReportLocation = null; }

  async function submitReportForm() {
    const photoFile = document.getElementById("report-photo-input").files[0];
    const severity = document.getElementById("report-severity-input").value;
    const description = document.getElementById("report-description-input").value.trim();
    const msgEl = document.getElementById("report-form-msg");
    const btn = document.getElementById("report-submit-btn");
    if (!photoFile) { msgEl.textContent = "Please add a photo."; msgEl.className = "popup-auth-msg error"; return; }
    if (!pendingReportLocation) { msgEl.textContent = "Location was lost — close this and try again."; msgEl.className = "popup-auth-msg error"; return; }
    btn.disabled = true; msgEl.textContent = "Uploading…"; msgEl.className = "popup-auth-msg";
    try {
      await PotholeAPI.submitReport({
        lat: pendingReportLocation.lat, lon: pendingReportLocation.lon, accuracy: pendingReportLocation.accuracy,
        description, severity, photoFile
      });
      closeReportForm();
      showError("Thanks — your report has been submitted."); // reuses the banner as a success toast; see styles.css .success variant
      loadReports();
    } catch (e) {
      msgEl.textContent = "Submit failed: " + e.message; msgEl.className = "popup-auth-msg error"; btn.disabled = false;
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────
  function popupHtml(report) {
    const st = getStatus(report.status);
    const photo = report.photoUrl ? `<img class="popup-photo" src="${escHtml(report.photoUrl)}" alt="Pothole photo">` : "";
    const date = report.timestamp ? new Date(report.timestamp).toLocaleDateString() : "";
    const planned = report.plannedDate ? `<div class="popup-meta"><span class="popup-status ps-planned">Planned: ${escHtml(report.plannedDate)}</span></div>` : "";
    const roadLine = report.roadName ? `<div class="popup-ward">${escHtml(report.roadName)}${report.ward ? " · " + escHtml(report.ward) : ""}</div>` : "";
    const adminControls = (authAuthorised && !authBanned) ? `
      <div class="popup-edit-area">
        <div class="filter-label">Set status</div>
        <div class="popup-status-select">${STATUSES.map(s => `<button class="popup-status-option${s.key === st.key ? " current" : ""}" onclick="adminSetReportStatus(${report._rowIdx},'${s.sheetValue}')">${escHtml(s.label)}</button>`).join("")}</div>
        <label class="form-label">Planned date</label>
        <input type="date" id="planned-date-${report._rowIdx}" value="${escHtml(report.plannedDate)}" onchange="adminSetPlannedDate(${report._rowIdx}, this.value)">
      </div>` : "";
    return `
      ${photo}
      <div class="popup-street">${escHtml(report.severity)} pothole</div>
      ${roadLine}
      <div class="popup-meta">
        <span class="popup-status ps-${st.key}">${escHtml(st.label)}</span>
        ${date ? `<span class="popup-residences">Reported ${escHtml(date)}</span>` : ""}
      </div>
      ${planned}
      ${report.description ? `<div class="popup-desc">${escHtml(report.description)}</div>` : ""}
      ${adminControls}
    `;
  }

  function renderMarkers() {
    reportMarkers.forEach(m => map.removeLayer(m));
    reportMarkers.clear();
    allReports.forEach(report => {
      if (!activeStatus.has(statusKey(report.status))) return;
      if (isNaN(report.lat) || isNaN(report.lon)) return;
      const marker = L.circleMarker([report.lat, report.lon], {
        radius: 8, color: "#fff", weight: 1.5, fillColor: colourFor(report.status), fillOpacity: 0.9
      });
      marker.bindPopup(popupHtml(report));
      marker.addTo(map);
      reportMarkers.set(report._rowIdx, marker);
    });
    updateStats();
  }

  // Cluster/priority-section overlay: draws a highlighted marker+circle at
  // each cluster's centroid sized/coloured by priority rank. (v1 keeps this
  // simple — a real road-section polyline overlay is a natural upgrade once
  // cluster_potholes.py starts emitting a geometry per cluster, not just a
  // centroid; see the plan's "Explicit follow-ups".)
  function renderClusters() {
    clusterLayerGroup.clearLayers();
    if (!clustersVisible) return;
    const maxRank = Math.max(1, ...allClusters.map(c => c.priorityRank || 999));
    allClusters.forEach(cluster => {
      if (isNaN(cluster.centroidLat) || isNaN(cluster.centroidLon)) return;
      const isTop = cluster.priorityRank && cluster.priorityRank <= 3;
      const circle = L.circle([cluster.centroidLat, cluster.centroidLon], {
        radius: 60, color: isTop ? "#ff7a3c" : "#a78bfa", weight: 2, fillOpacity: 0.15
      });
      circle.bindPopup(`
        <div class="popup-street">${escHtml(cluster.roadName || "Unnamed section")}</div>
        <div class="popup-ward">${escHtml(cluster.ward)}</div>
        <div class="popup-meta">
          <span class="popup-status ps-planned">Priority #${cluster.priorityRank ?? "-"}</span>
          <span class="popup-residences">${cluster.reportCount} report${cluster.reportCount === 1 ? "" : "s"}</span>
        </div>
        <div class="popup-desc">${escHtml(cluster.notes || "")}</div>
      `);
      circle.addTo(clusterLayerGroup);
    });
  }
  function toggleClusterOverlay() {
    clustersVisible = !clustersVisible;
    const btn = document.getElementById("clusters-toggle-btn");
    btn.textContent = clustersVisible ? "Hide prioritised sections" : "Show prioritised sections";
    if (clustersVisible) { clusterLayerGroup.addTo(map); renderClusters(); }
    else map.removeLayer(clusterLayerGroup);
  }

  function updateStats() {
    STATUSES.forEach(s => {
      const el = document.getElementById("stat-" + s.key);
      if (el) el.textContent = allReports.filter(r => statusKey(r.status) === s.key).length;
      const cnt = document.getElementById("cnt-" + s.key);
      if (cnt) cnt.textContent = allReports.filter(r => statusKey(r.status) === s.key).length;
    });
  }
  function toggleStatus(btn) {
    const s = btn.dataset.status;
    if (activeStatus.has(s)) { activeStatus.delete(s); btn.classList.replace("active", "inactive"); }
    else { activeStatus.add(s); btn.classList.replace("inactive", "active"); }
    renderMarkers();
  }

  // ── Admin actions ────────────────────────────────────────────────────────
  async function adminSetReportStatus(rowIdx, status) {
    try {
      await PotholeAPI.updateReportStatus({ rowIdx, status }, authTp());
      const r = allReports.find(x => x._rowIdx === rowIdx); if (r) r.status = status;
      renderMarkers();
    } catch (e) { showError("Update failed: " + e.message); }
  }
  async function adminSetPlannedDate(rowIdx, plannedDate) {
    try {
      const r = allReports.find(x => x._rowIdx === rowIdx);
      await PotholeAPI.updateReportStatus({ rowIdx, status: r ? r.status : undefined, plannedDate }, authTp());
      if (r) r.plannedDate = plannedDate;
    } catch (e) { showError("Update failed: " + e.message); }
  }

  // ── Data loading / polling ──────────────────────────────────────────────
  function setSyncState(state, text) {
    const dot = document.getElementById("sync-dot"), txt = document.getElementById("sync-text"), icon = document.getElementById("sync-icon");
    dot.className = ""; icon.classList.remove("spinning"); dot.classList.add(state); txt.textContent = text;
    if (state === "checking") icon.classList.add("spinning");
  }
  function formatTime(d) { return d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "never"; }
  let lastLoadTime = null;

  async function loadReports(isFirst) {
    if (isFirst) { document.getElementById("loading-msg").textContent = "Loading reports…"; document.getElementById("loading").classList.remove("hidden"); }
    try {
      allReports = await PotholeAPI.fetchReports();
      renderMarkers();
      if (isFirst && allReports.length) {
        const pts = allReports.filter(r => !isNaN(r.lat) && !isNaN(r.lon)).map(r => [r.lat, r.lon]);
        if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 15 });
      }
      lastLoadTime = new Date();
      setSyncState("fresh", "Updated " + formatTime(lastLoadTime));
    } catch (e) {
      setSyncState("error", "Check failed · " + formatTime(lastLoadTime));
      if (isFirst) showError("Couldn't load reports: " + e.message);
    } finally {
      document.getElementById("loading").classList.add("hidden");
    }
  }
  async function loadClusters() {
    try { allClusters = await PotholeAPI.fetchClusters(); renderClusters(); } catch (e) { /* clusters are optional decoration — never block on this */ }
  }

  async function checkForUpdates(isManual) {
    if (isChecking) return;
    isChecking = true;
    setSyncState("checking", isManual ? "Checking…" : "Checking for updates…");
    try { await loadReports(false); await loadClusters(); }
    finally { isChecking = false; schedulePoll(); }
  }
  function schedulePoll() { clearTimeout(pollTimer); pollTimer = setTimeout(() => checkForUpdates(false), POLL_INTERVAL_MS); }
  function manualRefresh() { clearTimeout(pollTimer); checkForUpdates(true); }
  window.addEventListener("online", () => { if (!isChecking) checkForUpdates(false); });

  // ── Error/toast banner ───────────────────────────────────────────────────
  function showError(msg) {
    const b = document.getElementById("error-banner");
    b.textContent = msg; b.style.display = "block";
    setTimeout(() => { b.style.display = "none"; }, 6000);
  }

  // ── Sidebar helpers (mobile) ─────────────────────────────────────────────
  function isMobile() { return window.innerWidth <= 640; }
  function closeSidebar() { document.getElementById("sidebar").classList.remove("open"); }
  let lastSidebarToggleTime = 0;
  function toggleSidebar(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    const now = Date.now();
    if (now - lastSidebarToggleTime < 400) return;
    lastSidebarToggleTime = now;
    document.getElementById("sidebar").classList.toggle("open");
  }
  map.on("click", () => { if (isMobile() && Date.now() - lastSidebarToggleTime > 400) closeSidebar(); });

  // ── Expose functions referenced from injected HTML's inline handlers ────
  Object.assign(window, {
    startReportFlow, closeReportForm, submitReportForm, toggleStatus, toggleClusterOverlay,
    triggerSignIn, signOut, adminSetReportStatus, adminSetPlannedDate, manualRefresh,
    toggleSidebar, cookieAccept, cookieDecline
  });

  // ── Boot ──────────────────────────────────────────────────────────────────
  restoreAuthSession();
  showCookieBanner();
  loadReports(true);
  loadClusters();
  schedulePoll();
})();
