// Agent processes get an allowlisted environment: nothing of the server's own
// configuration or secrets (database paths, other users' keys) leaks into them.
const PASS_THROUGH = [
  'PATH',
  'LANG',
  'LC_ALL',
  'TZ',
  'TERM',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

export function allowlistedEnv(
  home: string,
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {
    HOME: home,
    XDG_CONFIG_HOME: `${home}/.config`,
    XDG_CACHE_HOME: `${home}/.cache`,
  };
  for (const key of PASS_THROUGH) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== '') env[key] = value;
  }
  return env;
}
