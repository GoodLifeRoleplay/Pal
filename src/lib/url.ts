export function normalizeBaseUrl(input: string): string {
  let s = input.trim();

  // add protocol if missing
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;

  // split off path to check for /v1/api
  const url = new URL(s);

  // default port 8212 if none provided
  if (!url.port) url.port = "8212";

  // ensure base path ends with /v1/api
  const p = url.pathname.replace(/\/+$/, ""); // strip trailing slash
  if (!/\/v1\/api$/i.test(p)) url.pathname = p + "/v1/api";

  // canonicalize trailing slash off
  return url.toString().replace(/\/+$/, "");
}
