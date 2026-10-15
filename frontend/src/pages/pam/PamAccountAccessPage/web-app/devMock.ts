// Dev-only switch for frontend/scripts/pam-web-app-mock-stream.mjs. `import.meta.env.DEV` is a build-time constant,
// so production bundles drop the branch together with the storage key. A value starting with "/" is resolved
// against the page origin, because the app CSP only allows same-origin WebSockets (proxy that path to the mock).
export const getDevMockWsUrl = (): string | null => {
  if (!import.meta.env.DEV) return null;
  try {
    const value = window.localStorage.getItem("pam-web-app:mock-ws-url");
    if (!value?.startsWith("/")) return value;
    const { protocol, host } = window.location;
    return `${protocol === "https:" ? "wss:" : "ws:"}//${host}${value}`;
  } catch {
    return null;
  }
};
