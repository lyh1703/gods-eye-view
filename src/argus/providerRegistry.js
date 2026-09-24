const REQUIRED_STRING_FIELDS = [
  'provider_id',
  'category',
  'geography',
  'auth_mode',
  'cost_class',
  'update_frequency',
  'latency',
  'coverage',
  'license_class',
  'retention_policy',
  'reliability',
  'adapter_status',
  'source_url',
];

function normalizeProvider(provider) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    throw new TypeError('provider must be an object');
  }

  const normalized = {
    ...provider,
    commercial_allowed: provider.commercial_allowed ?? null,
    attribution_required: provider.attribution_required ?? false,
  };

  for (const field of REQUIRED_STRING_FIELDS) {
    if (
      typeof normalized[field] !== 'string' ||
      normalized[field].trim() === ''
    ) {
      throw new TypeError(`${field} must be a non-empty string`);
    }
  }

  if (
    normalized.commercial_allowed !== null &&
    typeof normalized.commercial_allowed !== 'boolean'
  ) {
    throw new TypeError('commercial_allowed must be boolean or null');
  }

  if (typeof normalized.attribution_required !== 'boolean') {
    throw new TypeError('attribution_required must be boolean');
  }

  return Object.freeze({ ...normalized });
}

export function createProviderRegistry(initialProviders = []) {
  const providers = new Map();

  function register(provider, { replace = false } = {}) {
    const normalized = normalizeProvider(provider);
    if (providers.has(normalized.provider_id) && !replace) {
      throw new Error(`provider already registered: ${normalized.provider_id}`);
    }
    providers.set(normalized.provider_id, normalized);
    return normalized;
  }

  function get(providerId) {
    return providers.get(providerId) ?? null;
  }

  function list({ commercialOnly = false, adapterStatus } = {}) {
    return [...providers.values()].filter((provider) => {
      if (commercialOnly && provider.commercial_allowed !== true) return false;
      if (adapterStatus && provider.adapter_status !== adapterStatus) {
        return false;
      }
      return true;
    });
  }

  for (const provider of initialProviders) register(provider);

  return Object.freeze({
    register,
    get,
    list,
    has: (providerId) => providers.has(providerId),
  });
}
