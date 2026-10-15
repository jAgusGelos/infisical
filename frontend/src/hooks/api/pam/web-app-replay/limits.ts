// The object and event caps match PAM_PLAYBACK_MAX_CHUNKS and PAM_PLAYBACK_MAX_TOTAL_EVENTS in
// session-playback/decrypt.ts, which is not imported to keep the API client out of this module.
export const WEB_APP_REPLAY_MAX_OBJECTS_PER_SERIES = 10_000;
// Matches the presign size cap of the gateway upload API.
export const WEB_APP_REPLAY_MAX_OBJECT_BYTES = 64 * 1024 * 1024;
export const WEB_APP_REPLAY_MAX_EVENTS = 500_000;
export const WEB_APP_REPLAY_MAX_BODY_PREVIEW_CHARS = 64 * 1024;
export const WEB_APP_REPLAY_FETCH_CONCURRENCY = 4;
export const WEB_APP_REPLAY_FETCH_TIMEOUT_MS = 30_000;
export const WEB_APP_REPLAY_POLL_INTERVAL_MS = 5000;
