# Stafford Pothole Watch

A citizen pothole-reporting app for Stafford. Anyone can report a pothole with their location, a description, severity, and an optional photo — no sign-in required. Reports are grouped into repair "sections" (clusters of nearby reports on the same road) and ranked by priority so a council can plan one visit per section instead of one per report.

Live: **https://daemeous.github.io/stafford-potholes/**

Sibling project — **[Leafletting Map](https://github.com/Daemeous/leaflet-map)** (canvassing tracker, same visual style, separate Sheet/Apps Script backend). Its live deployments:

| Constituency / area | Site |
|---|---|
| Stafford | https://daemeous.github.io/leaflet-map/ |
| Demo | https://daemeous.github.io/leaflet-map-demo/ |
| South Hams | https://daemeous.github.io/south-hams/ |
| Burton & Uttoxeter | https://daemeous.github.io/burton-uttoxeter/ |
| Stone, Great Wyrley & Penkridge | https://daemeous.github.io/stone/ |
| Barnsley, Penistone & Stocksbridge | https://daemeous.github.io/barnsley/ |
| St Helens | https://daemeous.github.io/sthelens/ |
| Shipley + Keighley and Ilkley | https://daemeous.github.io/shipley/ |
| Bassetlaw | https://daemeous.github.io/bassetlaw/ |

The tooling that creates and deploys a new area's Google Sheet + Apps Script backend (via `clasp`) lives in **[leaflet-pipeline](https://github.com/Daemeous/leaflet-pipeline)**, not in this repo. The road-snapping/clustering script that turns raw reports into prioritised sections (`cluster_potholes.py`) lives there too.

---

## How it works

Reports go straight into a Google Sheet's `Reports` tab via a Google Apps Script web app (no sign-in needed for reporting — only status/cluster edits require an authorised Google sign-in). A separate offline script (`cluster_potholes.py`, in leaflet-pipeline) periodically snaps reports to the nearest road, groups nearby reports into repair sections, and ranks them by a pluggable priority score (report count, severity, report age, and residences-on-that-road today; road hierarchy/traffic-volume/defect-depth/budget-band factors are wired in but not yet populated by any data source). Its output gets pasted into the Sheet's `Clusters` tab. The app reads both tabs as published CSV.

## Repository contents

| File | Purpose |
|------|---------|
| `index.html` | This deployment's config block (Sheet ID, Apps Script URL, title/subtitle, map centre) |
| `api.js` | The only module that talks to Apps Script / the published CSV URLs — `core.js` never fetches them directly, so the backend can be swapped later without touching `core.js` |
| `core.js` | App logic (map rendering, report form, admin panel) — forked from the leafletting map's `core.js`, not shared/CDN-loaded the way the leafletting map's constituency deployments are, since this app's data model (reports/photos) differs enough that keeping it standalone was simpler |
| `styles.css` | Same visual language as the leafletting map, kept as its own copy for the same reason as `core.js` |
| `sw.js` | Service worker (PWA offline shell) |

## Backend notes

The Apps Script backend (see leaflet-pipeline's `Pothole App/AppsScript.txt`) auto-provisions things a fresh deployment would otherwise need set up by hand:
- `GOOGLE_CLIENT_ID` falls back to the same shared OAuth client the leafletting map deployments use, so sign-in works immediately on any `daemeous.github.io/...` origin.
- `PHOTOS_FOLDER_ID` (the Drive folder pothole photos get uploaded to) is created lazily on first photo upload rather than needing a manual Drive-folder-plus-Script-Property step.

The one step that still has to be done by hand for a new deployment is Google Sheets' own "Publish to web" toggle (Drive API access to flip that programmatically is blocked by this environment's safety tooling, deliberately, since it changes a file's public-sharing state) — see leaflet-pipeline's README for the full deploy sequence.

---

## License

This project's own code is licensed under the **[PolyForm Noncommercial License 1.0.0](LICENSE)**: free to use, share, and modify for any non-commercial purpose, with attribution. See [`LICENSE`](LICENSE) for the full text.

Copyright © Daniel Hodgkins.

That covers this project's own code only. The road data reports get matched against (via [leaflet-pipeline](https://github.com/Daemeous/leaflet-pipeline)'s `cluster_potholes.py`) is ultimately sourced from OpenStreetMap and Ordnance Survey datasets under their own separate licenses that explicitly permit commercial use (see Attributions below) — this project's non-commercial restriction doesn't, and legally can't, extend to that underlying data.

## Attributions

| Dependency | License | Notes |
|---|---|---|
| [Leaflet.js](https://leafletjs.com) | BSD-2-Clause | © Vladimir Agafonkin and contributors |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) | [ODbL](https://opendatacommons.org/licenses/odbl/) | Map tiles, and (via leaflet-pipeline) the road network reports get snapped to. Permits commercial use; requires attribution and share-alike for derivative databases. |
| OS Boundary-Line & OS Open UPRN | [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/) | © Crown copyright and database right, Ordnance Survey — used by leaflet-pipeline to build the road network this app snaps reports to. Permits commercial use; requires attribution. |
| [Papa Parse](https://www.papaparse.com) | MIT | CSV parsing |
| [Turf.js](https://turfjs.org) | MIT | Geospatial analysis |
| Google Identity Services, Drive & Apps Script | [Google Terms of Service](https://policies.google.com/terms) | Sign-in, photo storage, and the report/cluster backend, all provided by Google |