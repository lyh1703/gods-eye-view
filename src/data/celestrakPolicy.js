export const CELESTRAK_TTL_MS = 6 * 3600_000;
export const CELESTRAK_FAILURE_DELAY_MS = 2 * 3600_000;

// Only fixed classifications cross HTTP/log/persistence boundaries. Never copy
// an upstream body, exception message, address, or arbitrary error code.
export function celestrakFailure(error, status = null) {
  let code = 'NETWORK_FAILURE';
  let name = 'ProviderError';
  const transport = error?.cause?.code ?? error?.code;
  if (status != null) {
    code =
      status === 403
        ? 'ACCESS_DENIED'
        : status === 429
          ? 'RATE_LIMIT'
          : status >= 500
            ? 'UPSTREAM_FAILURE'
            : 'HTTP_FAILURE';
  } else if (error?.name === 'TimeoutError') {
    code = 'TIMEOUT';
    name = 'TimeoutError';
  } else if (error?.name === 'AbortError') {
    code = 'ABORTED';
    name = 'AbortError';
  } else if (['ENOTFOUND', 'EAI_AGAIN'].includes(transport))
    code = 'DNS_FAILURE';
  else if (
    [
      'CERT_HAS_EXPIRED',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    ].includes(transport)
  )
    code = 'TLS_FAILURE';
  else if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(transport))
    code = 'CONNECT_TIMEOUT';
  else if (transport === 'ECONNREFUSED') code = 'CONNECTION_REFUSED';
  else if (transport === 'ECONNRESET') code = 'CONNECTION_RESET';
  else if (transport === 'RESPONSE_TOO_LARGE') code = 'OVERSIZED_RESPONSE';
  else if (transport === 'MALFORMED_PAYLOAD') code = 'MALFORMED_PAYLOAD';
  return { name, code, http_status: status, retryable: false };
}

export function celestrakError(diagnostic) {
  return Object.assign(new Error(`CelesTrak ${diagnostic.code}`), diagnostic, {
    diagnostic,
    retryable: false,
  });
}

// GP FORMAT=tle is a complete three-line catalog. Reject partial/error pages
// rather than replacing a good cache with a response containing just one '1 '.
export function validCelestrakTle(body) {
  if (typeof body !== 'string') return false;
  const lines = body
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (!lines.length || lines.length % 3 !== 0) return false;
  for (let i = 0; i < lines.length; i += 3) {
    const one = lines[i + 1];
    const two = lines[i + 2];
    if (
      !lines[i] ||
      !/^1 [\dA-Z ]{5}[UCS] /.test(one) ||
      !/^2 [\dA-Z ]{5} /.test(two) ||
      one.length !== 69 ||
      two.length !== 69 ||
      one.slice(2, 7) !== two.slice(2, 7) ||
      !/^\d{5}\.\d{8}$/.test(one.slice(18, 32))
    )
      return false;
  }
  return true;
}
