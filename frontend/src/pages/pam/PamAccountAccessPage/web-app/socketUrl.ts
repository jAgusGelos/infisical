export const toSameOriginWsUrl = (path: string) => {
  const { protocol, host } = window.location;
  return `${protocol === "https:" ? "wss:" : "ws:"}//${host}${path}`;
};
