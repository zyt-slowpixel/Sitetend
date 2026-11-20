/**
 * SiteKeeper Module Contracts & Error Definitions (v0.3 Spec Section 5)
 *
 * Defines unified input, output, schemaVersion rules, and error formats across:
 * - Core
 * - WorkspaceAdapter
 * - SourceParser
 * - SiteAdapter
 * - ModelProvider
 * - Publisher
 * - Dashboard
 *
 * Principle: Core never depends on Alex Morgan specific fields or specific model formats.
 */

export const SUPPORTED_SCHEMA_VERSION = 1;

export const ERROR_CODES = Object.freeze({
  UNSUPPORTED_SCHEMA_VERSION: 'UNSUPPORTED_SCHEMA_VERSION',
  INVALID_CONTENT_FORMAT: 'INVALID_CONTENT_FORMAT',
  FIELD_NOT_EDITABLE: 'FIELD_NOT_EDITABLE',
  FIELD_VALIDATION_FAILED: 'FIELD_VALIDATION_FAILED',
  PATH_OUT_OF_SCOPE: 'PATH_OUT_OF_SCOPE',
  WORKSPACE_PERMISSION_DENIED: 'WORKSPACE_PERMISSION_DENIED',
  WORKSPACE_FILE_NOT_FOUND: 'WORKSPACE_FILE_NOT_FOUND',
  WORKSPACE_IO_ERROR: 'WORKSPACE_IO_ERROR',
  BASELINE_CONFLICT_DETECTED: 'BASELINE_CONFLICT_DETECTED',
  STALE_DRAFT_DETECTED: 'STALE_DRAFT_DETECTED',
  SNAPSHOT_NOT_FOUND: 'SNAPSHOT_NOT_FOUND',
  PARSER_EXTRACTION_FAILED: 'PARSER_EXTRACTION_FAILED',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  PROVIDER_UNREACHABLE: 'PROVIDER_UNREACHABLE',   // network: no answer from the model server (offline, VPN, DNS)
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  PROVIDER_AUTH: 'PROVIDER_AUTH',                 // 401 / 403: the key was refused
  PUBLISH_FAILED: 'PUBLISH_FAILED',
});

/**
 * Standard result envelope returned by all SiteKeeper modules.
 * @template T
 * @typedef {Object} ModuleResult
 * @property {boolean} ok
 * @property {T|null} data
 * @property {SiteKeeperErrorPayload|null} error
 */

/**
 * @typedef {Object} SiteKeeperErrorPayload
 * @property {string} code - One of ERROR_CODES
 * @property {string} module - Module name ('Core'|'WorkspaceAdapter'|'SiteAdapter'|'SourceParser'|'ModelProvider'|'Publisher')
 * @property {string} message - Human-readable message
 * @property {Object} [details] - Structured context (e.g., fieldPath, expectedHash, actualHash, schemaVersion)
 * @property {boolean} recoverable - Whether user action can recover without data loss
 */

export function createOk(data = null) {
  return { ok: true, data, error: null };
}

export function createErr(code, module, message, details = {}, recoverable = true) {
  return {
    ok: false,
    data: null,
    error: {
      code,
      module,
      message,
      details,
      recoverable,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Validates that a persisted JSON object contains a supported schemaVersion.
 * Refuses to silently overwrite unsupported versions (Spec 5.3).
 */
export function validateSchemaVersion(obj, entityName = 'Document', expectedVersion = SUPPORTED_SCHEMA_VERSION) {
  if (!obj || typeof obj !== 'object') {
    return createErr(
      ERROR_CODES.INVALID_CONTENT_FORMAT,
      'Core',
      `${entityName} is not a valid JSON object.`,
      { entityName },
      false
    );
  }
  if (typeof obj.schemaVersion !== 'number') {
    return createErr(
      ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION,
      'Core',
      `${entityName} has no schemaVersion, so it is not overwritten.`,
      { entityName, received: obj.schemaVersion, expected: expectedVersion },
      false
    );
  }
  if (obj.schemaVersion !== expectedVersion) {
    return createErr(
      ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION,
      'Core',
      `${entityName} has schemaVersion ${obj.schemaVersion}, but this version needs v${expectedVersion}. Writing was stopped to protect the data.`,
      { entityName, received: obj.schemaVersion, expected: expectedVersion },
      false
    );
  }
  return createOk({ schemaVersion: obj.schemaVersion });
}

/**
 * Deterministic string hash (FNV-1a 32-bit hex) for content baseline comparison in browser & Node.
 */
export function legacyContentHash(input) {
  const str = typeof input === 'string' ? input : JSON.stringify(input);
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return 'fnv1a_' + (hash >>> 0).toString(16).padStart(8, '0');
}

/** Sorts object keys recursively so key order / formatting never changes the hash. */
export function stableStringify(value) {
  const norm = v => Array.isArray(v) ? v.map(norm)
    : (v && typeof v === 'object') ? Object.fromEntries(Object.keys(v).sort().map(k => [k, norm(v[k])])) : v;
  return JSON.stringify(norm(value));
}

/**
 * Deterministic, key-order-independent 128-bit content hash (4 independent 32-bit lanes), synchronous.
 * Reformatting or reordering keys in content.json (e.g. by an AI coding tool or Prettier) does not count as a change.
 */
export function computeContentHash(input) {
  const str = typeof input === 'string' ? input : stableStringify(input);
  const seeds = [0x811c9dc5, 0x9747b28c, 0x2f8a3c1d, 0x5bd1e995];
  const lanes = seeds.map(seed => {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
      h ^= h >>> 15;
      h = Math.imul(h, 0x85ebca6b + seed);
    }
    h ^= str.length; h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15;
    return (h >>> 0).toString(16).padStart(8, '0');
  });
  return 'h2_' + lanes.join('');
}

/** Compares content to a stored hash, accepting legacy (pre-2026-11-11) FNV hashes. */
export function contentMatchesHash(content, hash) {
  if (!hash) return false;
  return hash.startsWith('fnv1a_') ? legacyContentHash(content) === hash : computeContentHash(content) === hash;
}

/**
 * Preview Message Protocol Constants (Spec 5.2)
 * Preview receives only rendering data & edit mode flags, never API keys or workspace handles.
 */
export const PREVIEW_PROTOCOL = Object.freeze({
  HOST_TO_PREVIEW_RENDER: 'SITEKEEPER_PREVIEW_RENDER',
  HOST_TO_PREVIEW_HIGHLIGHT: 'SITEKEEPER_PREVIEW_HIGHLIGHT',
  PREVIEW_TO_HOST_READY: 'SITEKEEPER_PREVIEW_READY',
  PREVIEW_TO_HOST_FIELD_CLICK: 'SITEKEEPER_PREVIEW_FIELD_CLICK',
});
