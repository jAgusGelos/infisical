// Fetch and size limits for the Web App replay. The object and event caps match PAM_PLAYBACK_MAX_CHUNKS and
// PAM_PLAYBACK_MAX_TOTAL_EVENTS (session-playback/decrypt.ts), which is not imported to keep the API client out.
export const WEB_APP_REPLAY_MAX_OBJECTS_PER_SERIES = 10_000;
// Presign cap of the upload API (CONTRACTS.md 6.9).
export const WEB_APP_REPLAY_MAX_OBJECT_BYTES = 64 * 1024 * 1024;
export const WEB_APP_REPLAY_MAX_EVENTS = 500_000;
export const WEB_APP_REPLAY_MAX_BODY_PREVIEW_CHARS = 64 * 1024;
export const WEB_APP_REPLAY_FETCH_CONCURRENCY = 4;
export const WEB_APP_REPLAY_FETCH_TIMEOUT_MS = 30_000;
export const WEB_APP_REPLAY_POLL_INTERVAL_MS = 5000;
