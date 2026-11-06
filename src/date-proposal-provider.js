'use strict';

const { readRecordState } = require('./record-state');

// Read only the existing shared places, without creating a list view or writing it.
function readProposalPlaces(stateFile) {
  const state = readRecordState(stateFile, { places: [] }, true, { strict: true, readOnly: true });
  return (state.places || []).filter(place => ['active', 'visited'].includes(place.status));
}
function point(place) {
  return Number.isFinite(place?.longitude) && Number.isFinite(place?.latitude)
    && place.longitude >= -180 && place.longitude <= 180 && place.latitude >= -90 && place.latitude <= 90;
}
function createDateProposalProvider(map) {
  const full = map?.available === true && map.fullCapabilities === true;
  return {
    canSearch: full && typeof map.searchPlace === 'function',
    canRoute: full && typeof map.walkingRoute === 'function',
    async search(category, city) {
      if (!full || !category || !city) return [];
      try { return await map.searchPlace(category, city); } catch { return []; }
    },
    async route(origin, destination) {
      if (!full || !point(origin) || !point(destination)) return null;
      // Only allowlisted place coordinates; no location service or live position.
      try {
        const result = await map.walkingRoute(origin, destination);
        if (!result || typeof result.durationSeconds !== 'number' || !Number.isFinite(result.durationSeconds)
          || result.durationSeconds <= 0) return null;
        // Existing map normalization maps an absent duration to zero; treat it as unknown.
        return { durationSeconds: result.durationSeconds };
      } catch { return null; }
    },
  };
}

module.exports = { createDateProposalProvider, readProposalPlaces };
