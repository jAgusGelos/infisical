import { toSameOriginWsUrl } from "./socketUrl";

const MOCK_WS_URL_STORAGE_KEY = "pam-web-app:mock-ws-url";

// Dev-only switch for frontend/scripts/pam-web-app-mock-stream.mjs. `import.meta.env.DEV` is a build-time constant,
// so production bundles drop the branch together with the storage key. A value starting with "/" is resolved
// against the page origin, because the app CSP only allows same-origin WebSockets (proxy that path to the mock).
export const getDevMockWsUrl = (): string | null => {
  if (!import.meta.env.DEV) return null;
  try {
    const value = window.localStorage.getItem(MOCK_WS_URL_STORAGE_KEY);
    return value?.startsWith("/") ? toSameOriginWsUrl(value) : value;
  } catch {
    return null;
  }
};
