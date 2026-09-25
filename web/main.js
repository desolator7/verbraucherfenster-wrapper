import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { createLatestRequest, groupPublications } from './map-state.js';
import './style.css';

maplibregl.setWorkerUrl(workerUrl);
const $ = (selector) => document.querySelector(selector);
const desktop = matchMedia('(min-width: 900px)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const emptyCollection = () => ({ type: 'FeatureCollection', features: [] });
const dataRequest = createLatestRequest();
const searchRequest = createLatestRequest();
const locationRequest = createLatestRequest();
const labels = new Map();
const englishNameFields = new Set(['name_en', 'name:en']);
const NAME_ZOOM = 14;
let namesVisible = false;
let filter = { type: 'all' };
let appliedFilter = null;
let current = emptyCollection();
let groups = [];
let showArchived = false;
let selectedPopup = null;
let listOpen = false;
let labelFrame = null;
let mapReady = false;
let hasData = false;
let tooltipTouchActive = false;
let touchTapCandidate = null;
let lastUiTap = null;

const map = new maplibregl.Map({
  container: 'map', style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [9.1, 50.55], zoom: 7, attributionControl: false,
  renderWorldCopies: false,
  locale: {
    'NavigationControl.ZoomIn': 'Vergrößern',
    'NavigationControl.ZoomOut': 'Verkleinern',
    'NavigationControl.ResetBearing': 'Karte nach Norden ausrichten',
    'AttributionControl.ToggleAttribution': 'Kartenquellen anzeigen',
    'Map.Title': 'Karte der LFGB-Veröffentlichungen',
  },
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');
let attributionControl = new maplibregl.AttributionControl({ compact: !desktop.matches });
map.addControl(attributionControl, 'bottom-right');

function showMessage(text, { error = false, retry = false } = {}) {
  $('#message').textContent = text;
  $('.map-notice').hidden = !text;
  $('.map-notice').dataset.error = String(error);
  $('#retry-button').hidden = !retry;
}
function germanNameExpression() {
  return ['coalesce', ['get', 'name:de'], ['get', 'name_de'], ['get', 'name']];
}
function expressionIncludes(expression, predicate) {
  return Array.isArray(expression)
    && (predicate(expression) || expression.some((part) => expressionIncludes(part, predicate)));
}
function germanizeTextField(expression) {
  if (typeof expression === 'string') {
    return /^\{(?:name_en|name:en)\}$/.test(expression.trim()) ? germanNameExpression() : expression;
  }
  if (!Array.isArray(expression)) return expression;
  if (expression[0] === 'case' && expressionIncludes(expression, (part) => part[0] === 'has' && part[1] === 'name:nonlatin')) {
    return germanNameExpression();
  }
  if (expression[0] === 'get' && englishNameFields.has(expression[1])) return germanNameExpression();
  const localized = expression.map(germanizeTextField);
  return localized.some((part, index) => part !== expression[index]) ? localized : expression;
}
function localizeBasemapNames() {
  for (const layer of map.getStyle().layers) {
    const textField = layer.layout?.['text-field'];
    if (textField === undefined) continue;
    const localizedTextField = germanizeTextField(textField);
    if (localizedTextField !== textField) map.setLayoutProperty(layer.id, 'text-field', localizedTextField);
  }
}
function entryName(entry) { return entry.name || `Eintrag ${entry.id}`; }
function formatPublicationDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  return match ? `${match[3]}.${match[2]}.${match[1]}` : '';
}
function isRecentPublication(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const published = new Date(Date.UTC(year, month - 1, day));
  if (published.getUTCFullYear() !== year || published.getUTCMonth() !== month - 1 || published.getUTCDate() !== day) return false;
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const ageInDays = Math.floor((today - published.getTime()) / 86400000);
  return ageInDays >= 0 && ageInDays < 7;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#icon-${name}`);
  svg.append(use);
  return svg;
}
function sourceLink(entry, compact = false) {
  if (entry.isArchived) {
    const status = document.createElement('span');
    status.className = compact ? 'tooltip-link archive-status' : 'archive-status';
    status.setAttribute('aria-label', `${entryName(entry)}: archiviert`);
    status.title = 'Archiviert';
    status.append(icon('archive'));
    return status;
  }
  const link = document.createElement('a');
  link.href = entry.sourceUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.draggable = false;
  link.className = compact ? 'tooltip-link' : 'source-link';
  link.setAttribute('aria-label', `${entryName(entry)}: Amtliche Originalseite öffnen (neuer Tab)`);
  if (!compact) link.append('Original ansehen');
  link.append(icon('arrow'));
  return link;
}
function tooltipContent(features) {
  const box = document.createElement('div');
  box.className = 'tooltip-items';
  for (const feature of features) {
    const row = document.createElement('div');
    row.className = 'tooltip-row';
    const details = document.createElement('div');
    details.className = 'tooltip-entry';
    const name = document.createElement('span');
    name.className = 'tooltip-name';
    name.textContent = entryName(feature.properties);
    details.append(name);
    const date = formatPublicationDate(feature.properties.publicationDate);
    const publicationDate = document.createElement('span');
    publicationDate.className = 'tooltip-date';
    publicationDate.textContent = date || 'Veröffentlichungsdatum nicht verfügbar';
    details.append(publicationDate);
    row.append(details, sourceLink(feature.properties, true));
    box.append(row);
  }
  return box;
}
function makePopup(persistent = false) {
  const popup = new maplibregl.Popup({
    className: 'publication-popup', maxWidth: '260px', offset: 10,
    closeButton: false, closeOnClick: !persistent, focusAfterOpen: false,
  });
  popup.on('open', () => {
    // MapLibre listens for gestures on the canvas container, not the outer map.
    const element = popup.getElement();
    map.getCanvasContainer().append(element);
    element.addEventListener('dragstart', (event) => event.preventDefault());
    // Allow native link activation without also selecting a point underneath.
    element.addEventListener('click', (event) => event.stopPropagation());
    element.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') event.stopPropagation();
    });
  });
  return popup;
}
function displayPopup(group) {
  selectedPopup?.remove();
  selectedPopup = null;
  if (namesVisible) return scheduleLabels();
  selectedPopup = makePopup().setLngLat(group.coordinates).setDOMContent(tooltipContent(group.features)).addTo(map);
}
function syncLabels() {
  labelFrame = null;
  // Keep touch targets attached until the gesture finishes, including at zoom 14.
  if (tooltipTouchActive) return;
  const visible = new Set();
  if (namesVisible && mapReady) {
    const bounds = map.getBounds();
    for (const group of groups) {
      if (!bounds.contains(group.coordinates)) continue;
      const point = map.project(group.coordinates);
      if (point.x < 0 || point.y < 0 || point.x > $('#map').clientWidth || point.y > $('#map').clientHeight) continue;
      visible.add(group.id);
      let label = labels.get(group.id);
      if (!label) {
        label = { popup: makePopup(true), signature: null };
        labels.set(group.id, label);
      }
      if (label.signature !== group.signature) {
        label.popup.setDOMContent(tooltipContent(group.features));
        label.signature = group.signature;
      }
      label.popup.setLngLat(group.coordinates);
      if (!label.popup.isOpen()) label.popup.addTo(map);
    }
  }
  for (const [id, label] of labels) {
    if (visible.has(id)) continue;
    label.popup.remove();
    labels.delete(id);
  }
}
function scheduleLabels() {
  if (labelFrame === null) labelFrame = requestAnimationFrame(syncLabels);
}
function updateNameMode() {
  if (!mapReady || tooltipTouchActive) return;
  const showNames = map.getZoom() >= NAME_ZOOM;
  if (namesVisible === showNames) return;
  namesVisible = showNames;
  selectedPopup?.remove();
  selectedPopup = null;
  for (const id of ['clusters', 'cluster-count', 'points', 'point-hit-area']) {
    map.setLayoutProperty(id, 'visibility', showNames ? 'none' : 'visible');
  }
  map.setLayoutProperty('all-points', 'visibility', showNames ? 'visible' : 'none');
  map.getCanvas().style.cursor = '';
  scheduleLabels();
}
function viewBounds() {
  const bounds = map.getBounds();
  return [
    Math.max(-180, Math.min(180, bounds.getWest())),
    Math.max(-90, Math.min(90, bounds.getSouth())),
    Math.max(-180, Math.min(180, bounds.getEast())),
    Math.max(-90, Math.min(90, bounds.getNorth())),
  ];
}
function updateActiveControls() {
  const radiusActive = appliedFilter?.type === 'radius';
  const placeActive = radiusActive && appliedFilter.origin === 'place';
  const viewActive = appliedFilter?.type === 'view'
    && viewBounds().every((value, index) => Math.abs(value - appliedFilter.bbox[index]) < 0.000001);
  $('#all-button').setAttribute('aria-pressed', String(appliedFilter?.type === 'all'));
  $('#locate-button').setAttribute('aria-pressed', String(radiusActive && appliedFilter.origin === 'location'));
  $('#view-button').setAttribute('aria-pressed', String(viewActive));
  $('.radius-control').dataset.active = String(radiusActive);
  $('#search-form').dataset.active = String(placeActive);
  $('#search-button').dataset.active = String(placeActive);
}
function visibleFeatures() {
  return current.features.filter((feature) => showArchived || !feature.properties.isArchived);
}
function setListOpen(open, restoreFocus = false) {
  listOpen = open;
  const expanded = desktop.matches || open;
  $('#results-panel').dataset.open = String(expanded);
  $('#results-content').hidden = !expanded;
  $('#results-toggle').setAttribute('aria-expanded', String(expanded));
  $('#results-toggle').setAttribute('aria-label', expanded ? 'Ergebnisliste schließen' : 'Ergebnisliste öffnen');
  if (restoreFocus && !desktop.matches) $('#results-toggle').focus();
}
function cameraPadding() {
  const height = $('#map').clientHeight;
  return {
    top: Math.min($('.map-overlay').offsetHeight + 28, height * .35),
    bottom: Math.min(desktop.matches ? 140 : 70, height * .25),
    left: 24,
    right: desktop.matches ? 360 : 24,
  };
}
function focusLocation(coordinates, zoom = 11) {
  const padding = cameraPadding();
  map.flyTo({
    center: coordinates, zoom,
    offset: [(padding.left - padding.right) / 2, (padding.top - padding.bottom) / 2],
    duration: reducedMotion.matches ? 0 : 650,
  });
}
function showHessen() {
  map.fitBounds([[7.75, 49.35], [10.3, 51.75]], {
    padding: cameraPadding(), duration: reducedMotion.matches ? 0 : 700,
    retainPadding: false,
  });
}
function renderList(features) {
  const list = $('#results-list');
  const fragment = document.createDocumentFragment();
  $('#results-heading').textContent = `${features.length} ${features.length === 1 ? 'Eintrag' : 'Einträge'}`;
  $('#results-empty').hidden = features.length !== 0;
  for (const feature of features) {
    const entry = feature.properties;
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'result-focus';
    button.setAttribute('aria-label', `${entryName(entry)} auf der Karte anzeigen`);
    const title = document.createElement('strong');
    title.textContent = entryName(entry);
    button.append(title, icon('locate'));
    button.addEventListener('click', () => {
      setListOpen(false, true);
      focusLocation(feature.geometry.coordinates, Math.max(map.getZoom(), 14));
      const group = groups.find((item) => item.features.some((point) => point.properties.id === entry.id));
      if (group) displayPopup(group);
    });
    li.append(button);
    const meta = [];
    const publicationDate = formatPublicationDate(entry.publicationDate);
    meta.push(publicationDate ? `Veröffentlicht am ${publicationDate}` : 'Veröffentlichungsdatum nicht verfügbar');
    if (entry.postalCode) meta.push(`PLZ ${entry.postalCode}`);
    if (Number.isFinite(entry.distanceKm)) meta.push(`${entry.distanceKm.toLocaleString('de-DE', { maximumFractionDigits: 1 })} km entfernt`);
    if (meta.length) {
      const line = document.createElement('span');
      line.className = 'result-meta';
      line.textContent = meta.join(' · ');
      li.append(line);
    }
    if (entry.summary) {
      const description = document.createElement('p');
      description.textContent = entry.summary;
      li.append(description);
    }
    li.append(sourceLink(entry));
    fragment.append(li);
  }
  list.replaceChildren(fragment);
}
function updateSources() {
  if (!mapReady) return;
  const original = current;
  const archivedVisible = showArchived;
  const snapshot = { ...current, features: visibleFeatures() };
  for (const id of ['publications', 'publications-all']) {
    map.getSource(id).setData(snapshot).catch(() => {
      if (original === current && archivedVisible === showArchived) showMessage('Die Kartenpunkte konnten nicht aktualisiert werden. Bitte erneut laden.', { error: true, retry: true });
    });
  }
}
function loadData() {
  const url = new URL('/api/v1/publications.geojson', location.origin);
  const requestedFilter = filter;
  if (requestedFilter.type === 'radius') {
    url.searchParams.set('lat', requestedFilter.latitude);
    url.searchParams.set('lon', requestedFilter.longitude);
    url.searchParams.set('radius_km', requestedFilter.radius);
  } else if (requestedFilter.type === 'view') {
    url.searchParams.set('bbox', requestedFilter.bbox.join(','));
  }
  showMessage('Einträge werden geladen …');
  $('#results-content').setAttribute('aria-busy', 'true');
  return dataRequest.run(async (signal) => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(response.status === 503
      ? 'Der erste Datenabruf läuft noch. Bitte später erneut versuchen.'
      : 'Die Daten konnten nicht geladen werden.');
    return response.json();
  }, {
    success(value) {
      current = value;
      for (const feature of current.features) {
        feature.properties.isNew = isRecentPublication(feature.properties.publicationDate);
      }
      hasData = true;
      appliedFilter = requestedFilter;
      updateActiveControls();
      groups = groupPublications(visibleFeatures());
      if (!tooltipTouchActive) {
        selectedPopup?.remove();
        selectedPopup = null;
      }
      updateSources();
      renderList(visibleFeatures());
      scheduleLabels();
      showMessage(visibleFeatures().length ? '' : 'Keine Einträge in diesem Suchbereich gefunden.');
    },
    error(error) {
      showMessage(`${error.message}${hasData ? ' Die bisherige Ansicht bleibt sichtbar.' : ''}`, { error: true, retry: true });
      if (!hasData) $('#results-heading').textContent = 'Daten nicht verfügbar';
    },
    settled() { $('#results-content').setAttribute('aria-busy', 'false'); },
  });
}
async function loadStatus() {
  try {
    const response = await fetch('/api/v1/status');
    if (!response.ok) throw new Error('Status unavailable');
    const value = await response.json();
    $('#updated-at').textContent = value.lastSuccessAt
      ? `Stand: ${new Date(value.lastSuccessAt).toLocaleString('de-DE')}${value.stale ? ' · Aktualisierung überfällig' : ''}`
      : 'Noch kein erfolgreicher Datenabruf';
  } catch { $('#updated-at').textContent = 'Aktualisierungsstatus nicht verfügbar'; }
}
map.on('load', () => {
  localizeBasemapNames();
  map.addSource('publications', {
    type: 'geojson', data: current, cluster: true, clusterMaxZoom: 18, clusterRadius: 45,
    clusterProperties: {
      recent_count: ['+', ['case', ['==', ['get', 'isNew'], true], 1, 0]],
      non_archived_count: ['+', ['case', ['==', ['get', 'isArchived'], true], 0, 1]],
    },
  });
  map.addSource('publications-all', { type: 'geojson', data: current });
  map.addLayer({ id: 'clusters', type: 'circle', source: 'publications', filter: ['has', 'point_count'], paint: { 'circle-color': ['case', ['>', ['get', 'recent_count'], 0], '#ff0000', ['==', ['get', 'non_archived_count'], 0], '#8b9290', '#ff9800'], 'circle-radius': ['step', ['get', 'point_count'], 20, 10, 25, 50, 31], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'cluster-count', type: 'symbol', source: 'publications', filter: ['has', 'point_count'], layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12 }, paint: { 'text-color': '#fff' } });
  const pointPaint = { 'circle-color': ['case', ['==', ['get', 'isArchived'], true], '#8b9290', ['==', ['get', 'isNew'], true], '#ff0000', '#ff9800'], 'circle-radius': 8, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 };
  map.addLayer({ id: 'points', type: 'circle', source: 'publications', filter: ['!', ['has', 'point_count']], paint: pointPaint });
  map.addLayer({ id: 'all-points', type: 'circle', source: 'publications-all', layout: { visibility: 'none' }, paint: pointPaint });
  // A larger transparent hit area makes isolated points easier to tap.
  map.addLayer({ id: 'point-hit-area', type: 'circle', source: 'publications', filter: ['!', ['has', 'point_count']], paint: { 'circle-radius': 22, 'circle-color': '#000', 'circle-opacity': 0 } });
  map.on('click', 'clusters', async (event) => {
    if (namesVisible) return;
    const feature = event.features?.[0];
    if (!feature) return;
    const snapshot = current;
    try {
      const zoom = await map.getSource('publications').getClusterExpansionZoom(feature.properties.cluster_id);
      if (snapshot === current && !namesVisible) focusLocation(feature.geometry.coordinates, zoom);
    } catch { showMessage('Die Kartengruppe wurde aktualisiert. Bitte erneut antippen.'); }
  });
  map.on('click', 'point-hit-area', (event) => {
    if (namesVisible || map.queryRenderedFeatures(event.point, { layers: ['clusters'] }).length) return;
    const features = event.features || [];
    const nearest = features.sort((a, b) => {
      const distance = (feature) => {
        const point = map.project(feature.geometry.coordinates);
        return Math.hypot(point.x - event.point.x, point.y - event.point.y);
      };
      return distance(a) - distance(b);
    })[0];
    if (!nearest) return;
    const group = groups.find((item) => item.features.some((feature) => String(feature.properties.id) === String(nearest.properties.id)));
    if (group) displayPopup(group);
  });
  for (const layer of ['clusters', 'point-hit-area']) {
    map.on('mouseenter', layer, () => { if (!namesVisible) map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
  }
  mapReady = true;
  updateNameMode();
  if (filter.type === 'all') showHessen();
});
map.on('zoom', updateNameMode);
map.on('move', scheduleLabels);
map.on('moveend', updateActiveControls);
map.on('movestart', () => {
  if (appliedFilter?.type === 'view') $('#view-button').setAttribute('aria-pressed', 'false');
});
map.on('resize', scheduleLabels);
map.on('error', () => showMessage('Die Karte konnte nicht vollständig geladen werden. Die Einträge sind auch in der Liste verfügbar.', { error: true }));

const mapZoomTouchZones = '.publication-popup, .map-overlay, .results, .map-notice, .maplibregl-ctrl';
function touchZone(target) {
  return target instanceof Element ? target.closest(mapZoomTouchZones) : null;
}
function zoomMapAt(clientX, clientY) {
  if (!mapReady) return;
  const rectangle = map.getContainer().getBoundingClientRect();
  const point = [clientX - rectangle.left, clientY - rectangle.top];
  const zoom = Math.min(map.getZoom() + 1, map.getMaxZoom());
  if (zoom <= map.getZoom()) return;
  map.zoomTo(zoom, {
    around: map.unproject(point),
    duration: reducedMotion.matches ? 0 : 300,
  });
}
const appShell = $('.app-shell');
appShell.addEventListener('touchstart', (event) => {
  const zone = touchZone(event.target);
  if (event.touches.length !== 1 || !zone || event.target.closest('input, textarea, [contenteditable="true"]')) {
    touchTapCandidate = null;
    lastUiTap = null;
    return;
  }

  const touch = event.touches[0];
  const now = performance.now();
  const previous = lastUiTap;
  lastUiTap = null;
  if (previous && previous.zone === zone && now - previous.time <= 350
    && Math.hypot(touch.clientX - previous.x, touch.clientY - previous.y) <= 32) {
    if (event.cancelable) event.preventDefault();
    touchTapCandidate = null;
    zoomMapAt(touch.clientX, touch.clientY);
    return;
  }
  touchTapCandidate = { zone, x: touch.clientX, y: touch.clientY };
}, { capture: true, passive: false });
appShell.addEventListener('touchend', (event) => {
  const candidate = touchTapCandidate;
  touchTapCandidate = null;
  if (!candidate || event.touches.length || event.changedTouches.length !== 1) return;
  const touch = event.changedTouches[0];
  if (Math.hypot(touch.clientX - candidate.x, touch.clientY - candidate.y) <= 32) {
    lastUiTap = { zone: candidate.zone, x: touch.clientX, y: touch.clientY, time: performance.now() };
  } else {
    lastUiTap = null;
  }
}, { capture: true, passive: true });
appShell.addEventListener('touchcancel', () => {
  touchTapCandidate = null;
  lastUiTap = null;
}, { capture: true, passive: true });

const gestureContainer = map.getCanvasContainer();
gestureContainer.addEventListener('touchstart', (event) => {
  if ([...event.touches].some((touch) => touch.target instanceof Element && touch.target.closest('.publication-popup'))) {
    tooltipTouchActive = true;
  }
}, { capture: true, passive: true });
for (const type of ['touchend', 'touchcancel']) {
  gestureContainer.addEventListener(type, (event) => {
    if (!tooltipTouchActive || [...event.touches].some((touch) => gestureContainer.contains(touch.target))) return;
    tooltipTouchActive = false;
    requestAnimationFrame(() => { updateNameMode(); scheduleLabels(); });
  }, { capture: true, passive: true });
}

function closeSearch(restoreFocus = false) {
  searchRequest.cancel();
  $('#search-feedback').hidden = true;
  $('#place-results').replaceChildren();
  $('#search-form').setAttribute('aria-busy', 'false');
  if (restoreFocus) $('#place-input').focus();
}
function cancelLocation() {
  locationRequest.cancel();
  $('#locate-button').removeAttribute('aria-busy');
}
function selectPlace(place, origin = 'place') {
  cancelLocation();
  closeSearch();
  filter = { type: 'radius', origin, ...place, radius: $('#radius-select').value };
  $('#radius-select').disabled = false;
  $('#place-input').value = place.name || '';
  $('#place-input').blur();
  setListOpen(false);
  focusLocation([place.longitude, place.latitude]);
  loadData();
}
$('#locate-button').addEventListener('click', () => {
  closeSearch();
  if (!navigator.geolocation) return showMessage('Dieser Browser unterstützt keine Standortfreigabe.', { error: true });
  $('#locate-button').setAttribute('aria-busy', 'true');
  showMessage('Standort wird ermittelt …');
  locationRequest.run(() => new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, timeout: 10000 });
  }), {
    success({ coords }) { selectPlace({ latitude: coords.latitude, longitude: coords.longitude }, 'location'); },
    error() { showMessage('Standort nicht verfügbar. Bitte Ort oder PLZ eingeben.', { error: true }); },
    settled() { $('#locate-button').removeAttribute('aria-busy'); },
  });
});
$('#search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  cancelLocation();
  closeSearch();
  const query = $('#place-input').value.trim();
  $('#search-feedback').hidden = false;
  if (query.length < 3) {
    $('#search-message').textContent = 'Bitte mindestens drei Zeichen eingeben.';
    return;
  }
  $('#search-message').textContent = 'Orte werden gesucht …';
  $('#search-form').setAttribute('aria-busy', 'true');
  searchRequest.run(async (signal) => {
    const response = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`, { signal });
    const places = await response.json();
    if (!response.ok) throw new Error(places.error || 'Die Ortssuche ist gerade nicht verfügbar.');
    return places;
  }, {
    success(places) {
      $('#search-message').textContent = places.length ? 'Bitte einen Ort auswählen.' : 'Kein passender Ort gefunden.';
      for (const place of places) {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = place.name;
        button.addEventListener('click', () => {
          selectPlace(place);
          $('#radius-select').focus({ preventScroll: true });
        });
        li.append(button);
        $('#place-results').append(li);
      }
    },
    error(error) { $('#search-message').textContent = error.message || 'Die Ortssuche ist gerade nicht verfügbar.'; },
    settled() { $('#search-form').setAttribute('aria-busy', 'false'); },
  });
});
$('#place-input').addEventListener('input', () => { closeSearch(); cancelLocation(); });
$('#search-close').addEventListener('click', () => closeSearch(true));
$('#radius-select').addEventListener('change', () => {
  if (filter.type !== 'radius') return;
  cancelLocation();
  filter = { ...filter, radius: $('#radius-select').value };
  loadData();
});
$('#all-button').addEventListener('click', () => {
  cancelLocation();
  closeSearch();
  filter = { type: 'all' };
  $('#place-input').value = '';
  $('#radius-select').disabled = true;
  setListOpen(false);
  showHessen();
  loadData();
});
$('#archive-button').addEventListener('click', () => {
  showArchived = !showArchived;
  const label = showArchived ? 'Archivierte Meldungen ausblenden' : 'Archivierte Meldungen einblenden';
  $('#archive-button').setAttribute('aria-pressed', String(showArchived));
  $('#archive-button').setAttribute('aria-label', label);
  $('#archive-button').title = label;
  groups = groupPublications(visibleFeatures());
  selectedPopup?.remove();
  selectedPopup = null;
  updateSources();
  renderList(visibleFeatures());
  scheduleLabels();
  showMessage(visibleFeatures().length ? '' : 'Keine Einträge in diesem Suchbereich gefunden.');
});
$('#retry-button').addEventListener('click', () => { loadData(); loadStatus(); });
$('#view-button').addEventListener('click', () => {
  cancelLocation();
  closeSearch();
  map.stop();
  filter = { type: 'view', bbox: viewBounds() };
  $('#place-input').value = '';
  $('#radius-select').disabled = true;
  loadData();
});
$('#results-toggle').addEventListener('click', () => setListOpen(!listOpen));
desktop.addEventListener('change', () => {
  const focusWasInside = $('#results-content').contains(document.activeElement);
  setListOpen(listOpen, focusWasInside);
  map.removeControl(attributionControl);
  attributionControl = new maplibregl.AttributionControl({ compact: !desktop.matches });
  map.addControl(attributionControl, 'bottom-right');
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || $('#about-dialog').open) return;
  if (!$('#search-feedback').hidden) closeSearch(true);
  else if (listOpen && !desktop.matches) setListOpen(false, true);
  else {
    const focusWasInside = selectedPopup?.getElement()?.contains(document.activeElement);
    selectedPopup?.remove();
    selectedPopup = null;
    if (focusWasInside) map.getCanvas().focus();
  }
});
$('#about-button').addEventListener('click', () => $('#about-dialog').showModal());
$('#about-close').addEventListener('click', () => $('#about-dialog').close());
// Resize the map when the browser changes the usable space, including the keyboard.
new ResizeObserver(() => map.resize()).observe($('.app-shell'));
function updateKeyboardHeight() {
  const editing = document.activeElement === $('#place-input');
  $('.app-shell').dataset.editing = String(editing);
  const height = editing && window.visualViewport ? `${window.visualViewport.height}px` : '';
  $('.app-shell').style.height = height;
  if (height) $('.app-shell').style.setProperty('--keyboard-height', height);
  else $('.app-shell').style.removeProperty('--keyboard-height');
}
window.visualViewport?.addEventListener('resize', updateKeyboardHeight);
$('#place-input').addEventListener('focus', updateKeyboardHeight);
$('#place-input').addEventListener('blur', updateKeyboardHeight);
setListOpen(false);
loadData();
loadStatus();
