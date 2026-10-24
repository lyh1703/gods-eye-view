// Human-readable read-only briefing from the existing verified ARGUS -> NEXUS query.
// This is a view of evidence, never a new verification or an independent source.
const CONTRACT = 'argus-nexus-verified-query-v0.1';
const PROVIDER = 'usgs-earthquakes-all-hour';

function safeText(value, max = 120) {
  return String(value ?? '정보 없음')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function officialSource(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.hostname === 'earthquake.usgs.gov' &&
      !url.username && !url.password &&
      !url.port;
  } catch {
    return false;
  }
}

function checkedTime(value) {
  if (typeof value !== 'string' ||
      !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ||
      !Number.isFinite(Date.parse(value))) {
    throw new TypeError('INVALID_OBSERVATION_TIME');
  }
  return new Date(value).toISOString();
}

export function renderPublicUsgsBriefing(result) {
  if (!result || result.contract_id !== CONTRACT ||
      result.operation !== 'query' || result.verified !== true ||
      result.data?.mode !== 'history' ||
      !Array.isArray(result.data.observations) ||
      !Array.isArray(result.evidence?.observation_ids) ||
      !Array.isArray(result.evidence?.source_urls) ||
      !Array.isArray(result.health?.ingestion_runs) ||
      result.health.partial_failure !== false) {
    throw new TypeError('UNVERIFIED_OR_DEGRADED_USGS_RESULT');
  }
  const runs = result.health.ingestion_runs;
  const requested = result.health.requested_providers;
  const provider = Array.isArray(requested) && requested.length === 1
    ? requested[0] : null;
  const hasItems = result.data.observations.length > 0;
  if (!provider || provider.provider_id !== PROVIDER ||
      provider.run?.status !== 'SUCCEEDED' ||
      (hasItems && (result.health.degraded !== false ||
        runs.length !== 1 || runs[0].status !== 'SUCCEEDED' ||
        provider.state !== 'OK')) ||
      (!hasItems && (runs.length !== 0 ||
        !['NO_DATA', 'OK'].includes(provider.state) ||
        result.health.degraded === true))) {
    throw new TypeError('UNVERIFIED_OR_DEGRADED_USGS_RESULT');
  }
  const windowEnd = checkedTime(result.data.time?.end);
  const observationIds = new Set(result.evidence.observation_ids);
  const sourceUrls = new Set(result.evidence.source_urls);
  const items = result.data.observations;
  if (items.length > 25 || result.data.count !== items.length) {
    throw new TypeError('INVALID_USGS_RESULT_COUNT');
  }
  const lines = [
    'USGS 최근 1시간 공개 지진 관측',
    '조회 종료 시각(UTC): ' + windowEnd,
    '관측 결과: ' + items.length + '건 (최대 25건 조회; 전체 지진 발생 수 아님)',
  ];
  if (items.length === 0) {
    lines.push('이 조회 범위에 검증 가능한 관측이 없습니다. 지진이 없었다는 뜻은 아닙니다.');
    return lines.join('\n');
  }
  for (const item of items) {
    if (item?.provider_id !== PROVIDER ||
        typeof item.observation_id !== 'string' ||
        !observationIds.has(item.observation_id) ||
        !officialSource(item.source_url) ||
        !sourceUrls.has(item.source_url)) {
      throw new TypeError('UNTRUSTED_USGS_BRIEFING_ITEM');
    }
    const observed = checkedTime(item.timestamp_observed);
    if (Date.parse(observed) > Date.parse(windowEnd) ||
        Date.parse(observed) < Date.parse(windowEnd) - 3600_000) {
      throw new TypeError('OUT_OF_WINDOW_USGS_OBSERVATION');
    }
    const magnitude = item.properties?.magnitude;
    const magnitudeText = typeof magnitude === 'number' &&
      Number.isFinite(magnitude) ? 'M' + magnitude.toFixed(1) : '규모 미상';
    lines.push('- ' + magnitudeText + ' | ' + safeText(item.properties?.place) + ' | ' + observed);
    lines.push('  출처: ' + item.source_url);
  }
  return lines.join('\n');
}
