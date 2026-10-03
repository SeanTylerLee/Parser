const STYLE_STREETS = "mapbox://styles/mapbox/streets-v12";
const STYLE_SAT = "mapbox://styles/mapbox/satellite-streets-v12";
const OKLAHOMA_CENTER = [-97.5, 35.5];

let map = null;
let markers = [];
let satellite = false;

export function hasMap() {
  return Boolean(map);
}

export function initMap(token, containerId = "map") {
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
    center: OKLAHOMA_CENTER,
    zoom: 6.2,
    attributionControl: true,
  });
  map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new mapboxgl.ScaleControl({ unit: "imperial" }));
  return map;
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

export function drawPermitRoute(route, { originLabel = "Start", destLabel = "End" } = {}) {
  if (!map || !route?.coordinates?.length) return;
  clearMapOverlays();
  const coords = route.coordinates;
  drawPins([
    {
      label: "Start",
      displayText: originLabel,
      lng: coords[0][0],
      lat: coords[0][1],
    },
    {
      label: "End",
      displayText: destLabel,
      lng: coords[coords.length - 1][0],
      lat: coords[coords.length - 1][1],
    },
  ]);
  drawRouteGeoJSON({
    type: "Feature",
    properties: { source: route.source || "permit-directions", point_count: coords.length },
    geometry: { type: "LineString", coordinates: coords },
  });
}

function drawPins(pins) {
  if (!map) return;
  const bounds = new mapboxgl.LngLatBounds();
  pins.forEach((pin, i) => {
    if (pin.lng == null || pin.lat == null) return;
    bounds.extend([pin.lng, pin.lat]);
    const el = document.createElement("div");
    el.className = `pin ${i === 0 ? "pin-origin" : "pin-destination"}`;
    el.textContent = i === 0 ? "A" : "B";
    el.title = pin.displayText || pin.label;
    const marker = new mapboxgl.Marker({ element: el, anchor: "bottom" })
      .setLngLat([pin.lng, pin.lat])
      .setPopup(
        new mapboxgl.Popup({ offset: 18 }).setHTML(
          `<strong>${escapeHtml(pin.label)}</strong><br>${escapeHtml(pin.displayText || "")}`,
        ),
      )
      .addTo(map);
    markers.push(marker);
  });
  if (!bounds.isEmpty()) {
    map.fitBounds(bounds, { padding: 56, maxZoom: 12, duration: 600 });
  }
}

function drawRouteGeoJSON(feature) {
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
      const step = Math.max(1, Math.floor(coords.length / 200));
      for (let i = 0; i < coords.length; i += step) bounds.extend(coords[i]);
      bounds.extend(coords[coords.length - 1]);
      map.fitBounds(bounds, { padding: 56, maxZoom: 12, duration: 600 });
    }
  };

  if (map.isStyleLoaded()) apply();
  else map.once("load", apply);
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
