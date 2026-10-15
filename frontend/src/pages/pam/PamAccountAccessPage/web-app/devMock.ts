// Dev-only switch for frontend/scripts/pam-web-app-mock-stream.mjs. `import.meta.env.DEV` is a build-time constant,
// so production bundles drop the branch together with the storage key.
export const getDevMockWsUrl = (): string | null => {
  if (!import.meta.env.DEV) return null;
  try {
    return window.localStorage.getItem("pam-web-app:mock-ws-url");
  } catch {
    return null;
  }
};
