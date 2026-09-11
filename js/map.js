import { TEXAS_CENTER, OKLAHOMA_CENTER } from "./geocode.js";

const STYLE_STREETS = "mapbox://styles/mapbox/streets-v12";
const STYLE_SAT = "mapbox://styles/mapbox/satellite-streets-v12";

let map = null;
let markers = [];
let satellite = false;

export function hasMap() {
  return Boolean(map);
}

export function initMap(token, containerId = "map", { state = "TX" } = {}) {
  if (!window.mapboxgl) throw new Error("Mapbox GL failed to load.");
  mapboxgl.accessToken = token;

  if (map) {
    map.remove();
    map = null;
    markers = [];
  }

  map = new mapboxgl.Map({
    container: containerId,
    style: STYLE_STREETS,
    center: stateCenter(state),
    zoom: state === "OK" ? 6.2 : 5.2,
    attributionControl: true,
  });
  map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new mapboxgl.ScaleControl({ unit: "imperial" }));
  return map;
}

export function setMapState(state) {
  if (!map) return;
  clearMapOverlays();
  map.easeTo({
    center: stateCenter(state),
    zoom: state === "OK" ? 6.2 : 5.2,
    duration: 500,
  });
}

function stateCenter(state) {
  return state === "OK" ? OKLAHOMA_CENTER : TEXAS_CENTER;
}

export function setSatellite(on) {
  if (!map) return;
  satellite = Boolean(on);
  const style = satellite ? STYLE_SAT : STYLE_STREETS;
  const route = map.getSource("permit-route") ? map.getSource("permit-route")._data : null;
  map.setStyle(style);
  if (route) {
    map.once("style.load", () => drawRouteGeoJSON(route));
  }
}

export function isSatellite() {
  return satellite;
}

export function clearMapOverlays() {
  markers.forEach((m) => m.remove());
  markers = [];
  if (!map) return;
  if (map.getLayer("permit-route-line")) map.removeLayer("permit-route-line");
  if (map.getLayer("permit-route-casing")) map.removeLayer("permit-route-casing");
  if (map.getSource("permit-route")) map.removeSource("permit-route");
}

export function drawPins(pins) {
  if (!map) return;
  markers.forEach((m) => m.remove());
  markers = [];

  const bounds = new mapboxgl.LngLatBounds();
  let any = false;

  pins.forEach((pin, i) => {
    if (pin.lng == null || pin.lat == null) return;
    any = true;
    bounds.extend([pin.lng, pin.lat]);
    const el = document.createElement("div");
    const kind =
      i === 0
        ? "origin"
        : i === pins.length - 1
          ? "destination"
          : "turn";
    el.className = `pin pin-${kind}${pin.weak ? " pin-weak" : ""}`;
    el.textContent = String(i + 1);
    el.title = pin.displayText || pin.text;
    const marker = new mapboxgl.Marker({ element: el, anchor: "bottom" })
      .setLngLat([pin.lng, pin.lat])
      .setPopup(
        new mapboxgl.Popup({ offset: 18 }).setHTML(
          `<strong>${escapeHtml(pin.label)}</strong><br>${escapeHtml(pin.displayText || pin.text)}` +
            (pin.place ? `<br><span class="muted">${escapeHtml(pin.place)}</span>` : "") +
            `<br><span class="muted">score ${Math.round(pin.score)}</span>`,
        ),
      )
      .addTo(map);
    markers.push(marker);
  });

  if (any) {
    if (pins.filter((p) => p.lng != null).length === 1) {
      map.easeTo({ center: bounds.getCenter(), zoom: 11 });
    } else {
      map.fitBounds(bounds, { padding: 56, maxZoom: 12, duration: 600 });
    }
  }
}

export function drawRouteGeoJSON(feature) {
  if (!map || !feature?.geometry) return;
  const apply = () => {
    if (map.getSource("permit-route")) {
      map.getSource("permit-route").setData(feature);
    } else {
      map.addSource("permit-route", { type: "geojson", data: feature });
      map.addLayer({
        id: "permit-route-casing",
        type: "line",
        source: "permit-route",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#001848", "line-width": 8, "line-opacity": 0.85 },
      });
      map.addLayer({
        id: "permit-route-line",
        type: "line",
        source: "permit-route",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#0070f8", "line-width": 4, "line-opacity": 0.95 },
      });
    }

    const coords = feature.geometry.coordinates || [];
    if (coords.length >= 2) {
      const bounds = new mapboxgl.LngLatBounds();
      // Sample for fitBounds speed on long TxPROS polylines.
      const step = Math.max(1, Math.floor(coords.length / 200));
      for (let i = 0; i < coords.length; i += step) bounds.extend(coords[i]);
      bounds.extend(coords[coords.length - 1]);
      map.fitBounds(bounds, { padding: 56, maxZoom: 12, duration: 600 });
    }
  };

  if (map.isStyleLoaded()) apply();
  else {
    map.once("load", apply);
    map.once("style.load", apply);
  }
}

/** Draw permit geometry: full polyline + start/end pins (optional custom pin list). */
export function drawPermitRoute(route, { originLabel = "Origin", destLabel = "Destination", pins } = {}) {
  if (!map || !route?.coordinates?.length) return;
  clearMapOverlays();
  const coords = route.coordinates;
  const endPins =
    pins?.length >= 2
      ? pins.filter((p) => p.lng != null && p.lat != null)
      : [
          {
            label: originLabel,
            displayText: originLabel,
            text: "Start",
            lng: coords[0][0],
            lat: coords[0][1],
            place: null,
            score: 100,
            weak: false,
            ok: true,
          },
          {
            label: destLabel,
            displayText: destLabel,
            text: "End",
            lng: coords[coords.length - 1][0],
            lat: coords[coords.length - 1][1],
            place: null,
            score: 100,
            weak: false,
            ok: true,
          },
        ];
  // Show start, end, and intermediate step/turn waypoints when present.
  const showPins =
    endPins.length <= 2
      ? endPins
      : endPins.map((p, i, arr) => {
          if (i === 0) return { ...p, label: p.label || "Origin" };
          if (i === arr.length - 1) return { ...p, label: p.label || "Destination" };
          return {
            ...p,
            label: p.label || "Turn",
            // Smaller visual weight via existing turn style
          };
        });
  drawPins(showPins);
  drawRouteGeoJSON({
    type: "Feature",
    properties: {
      source: route.source || "permit",
      point_count: coords.length,
    },
    geometry: { type: "LineString", coordinates: coords },
  });
}

/** @deprecated use drawPermitRoute */
export function drawTxprosRoute(route) {
  return drawPermitRoute(route, {
    originLabel: "TxPROS start",
    destLabel: "TxPROS end",
  });
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
