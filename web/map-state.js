// Group co-located publications without losing distinct entries or repeating IDs.
export function groupPublications(features) {
  const locations = new Map();
  const seen = new Set();
  for (const feature of features) {
    const id = String(feature.properties.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const coordinates = feature.geometry.coordinates;
    const key = JSON.stringify(coordinates);
    if (!locations.has(key)) locations.set(key, { coordinates, features: [] });
    locations.get(key).features.push(feature);
  }
  return [...locations.values()].map((group) => {
    group.features.sort((a, b) => String(a.properties.id).localeCompare(String(b.properties.id)));
    return {
      ...group,
      id: String(group.features[0].properties.id),
      signature: JSON.stringify(group.features.map(({ properties: p }) => [p.id, p.name, p.sourceUrl, p.publicationDate])),
    };
  });
}

// Tokens also protect against operations (such as geolocation) that ignore abort.
export function createLatestRequest() {
  let active;
  function cancel() {
    active?.abort();
    active = undefined;
  }
  return {
    cancel,
    async run(task, { success, error, settled } = {}) {
      cancel();
      const controller = new AbortController();
      active = controller;
      try {
        const value = await task(controller.signal);
        if (active === controller) success?.(value);
      } catch (cause) {
        if (active === controller && cause.name !== 'AbortError') error?.(cause);
      } finally {
        if (active === controller) {
          settled?.();
          active = undefined;
        }
      }
    },
  };
}
