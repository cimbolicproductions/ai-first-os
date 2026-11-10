"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");

const DEFAULT_TABS = new Set(["Tasks", "Updates", "Pinned", "File log", "Done", "How this works", "Home"]);
const SHEET_ID_TO_TAB = Object.freeze({ 0: "Tasks", 1: "Updates", 3: "File log" });

const SCOPES = Object.freeze({
  readOnly: "https://www.googleapis.com/auth/spreadsheets.readonly",
  readWrite: "https://www.googleapis.com/auth/spreadsheets",
});

class BoardAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BoardAdapterError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new BoardAdapterError(code, message);
}

function safeMessage(value) {
  return String(value ?? "Unknown error")
    .replace(/("(?:access_token|refresh_token|client_secret|private_key|api_?key|authorization|token)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[redacted]"')
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[redacted]")
    .replace(/((?:access_token|refresh_token|client_secret|private_key|api_key|authorization)\s*[=:]\s*)[^\s,;&]+/gi, "$1[redacted]")
    .slice(0, 500);
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function validateBoardId(boardId) {
  if (typeof boardId !== "string" || !/^[A-Za-z0-9_-]{12,128}$/.test(boardId)) {
    fail("CONFIG_REQUIRED", "Provide a valid Google Spreadsheet boardId in config.");
  }
  return boardId;
}

function normalizeTab(value, allowedTabs = DEFAULT_TABS) {
  if (typeof value !== "string") fail("INVALID_REQUEST", "An exact board tab name is required.");
  const tab = value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1).replace(/''/g, "'") : value;
  if (!allowedTabs.has(tab)) fail("INVALID_REQUEST", "Unknown Agent Tasks tab.");
  return tab;
}

function formatA1Range(sheetName, rectangle) {
  const safeName = /[^A-Za-z0-9_]/.test(sheetName)
    ? `'${sheetName.replace(/'/g, "''")}'`
    : sheetName;
  return `${safeName}!${rectangle}`;
}

function validateRectangle(value) {
  const m = /^([A-Z]{1,2})([1-9][0-9]*)(?::([A-Z]{1,2})([1-9][0-9]*))?$/.exec(value);
  if (!m) fail("INVALID_REQUEST", "Use a bounded A1 cell rectangle.");
  const column = s => [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  const left = column(m[1]);
  const right = column(m[3] || m[1]);
  const top = Number(m[2]);
  const bottom = Number(m[4] || m[2]);
  if (right < left || bottom < top || right > 26 || bottom > 10000 || (right - left + 1) * (bottom - top + 1) > 50000) {
    fail("INVALID_REQUEST", "Board range exceeds the supported bounded scan.");
  }
}

function validateFullRange(value, allowedTabs = DEFAULT_TABS) {
  const m = /^(?:'((?:[^']|'')+)'|([^'!]+))!(.+)$/.exec(value);
  if (!m) fail("INVALID_REQUEST", "A cell range must include an exact tab name.");
  normalizeTab(m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2], allowedTabs);
  validateRectangle(m[3]);
}

function validateWrite(requests) {
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > 50) {
    fail("INVALID_REQUEST", "Use a bounded nonempty board write batch.");
  }
  for (const request of requests) {
    if (!request || typeof request !== "object" || Object.keys(request).length !== 1) {
      fail("INVALID_REQUEST", "Each board write must have one request type.");
    }
    const u = request.updateCells || request.appendCells;
    const r = u?.range;
    const sheet = r?.sheetId ?? u?.sheetId;
    if (!u || ![0, 1, 3].includes(sheet) || u.fields !== "userEnteredValue") {
      fail("INVALID_REQUEST", "Only literal board cell writes are supported.");
    }
    const width = r ? r.endColumnIndex - r.startColumnIndex : sheet === 1 ? 6 : 4;
    if (r) {
      const ints = [r.startRowIndex, r.endRowIndex, r.startColumnIndex, r.endColumnIndex];
      const tabWidth = sheet === 0 ? 10 : sheet === 1 ? 6 : 4;
      if (!ints.every(Number.isInteger) || r.startColumnIndex < 0 || r.endColumnIndex > tabWidth || width < 1 || width > tabWidth) {
        fail("INVALID_REQUEST", "Write columns exceed the supported tab width.");
      }
      const allowed = sheet === 0 ? [2, 3, 4, 7] : sheet === 1 ? [0, 1, 2, 3, 4, 5] : [0, 1, 2, 3];
      if (
        r.startRowIndex < 1 ||
        r.endRowIndex > 10000 ||
        r.endRowIndex - r.startRowIndex !== u.rows?.length ||
        !Array.from({ length: width }, (_, i) => i + r.startColumnIndex).every(c => allowed.includes(c))
      ) {
        fail("INVALID_REQUEST", "Invalid or unsupported board write range.");
      }
    } else if (sheet === 0) {
      fail("INVALID_REQUEST", "Task rows cannot be appended by this adapter.");
    }
    if (
      !Array.isArray(u.rows) ||
      !u.rows.length ||
      u.rows.some(
        row =>
          row.values?.length !== width ||
          row.values.some(
            cell =>
              Object.keys(cell).length !== 1 ||
              Object.keys(cell.userEnteredValue || {}).length !== 1 ||
              typeof cell.userEnteredValue?.stringValue !== "string"
          )
      )
    ) {
      fail("INVALID_REQUEST", "Use complete rows of literal strings.");
    }
  }
}

function prepareRequest(request, options = {}) {
  const boardId = validateBoardId(options.boardId);
  const allowedTabs = options.allowedTabs || DEFAULT_TABS;
  let cloned;
  try {
    cloned = structuredClone(request);
  } catch {
    fail("INVALID_REQUEST", "Board requests must contain plain data.");
  }
  const op = cloned?.operation;
  if (!["get_range", "get_cells", "get_metadata", "get_protocol", "batch_update"].includes(op)) {
    fail("INVALID_REQUEST", "Unsupported board operation.");
  }
  const a = cloned.arguments;
  if (!a || typeof a !== "object" || Array.isArray(a)) {
    fail("INVALID_REQUEST", "Board arguments must be an object.");
  }
  if (op === "get_protocol") {
    if (Object.keys(a).length) fail("INVALID_REQUEST", "The protocol file is fixed.");
    return deepFreeze({ operation: op, arguments: { fileId: options.protocolFileId || null } });
  }
  if ((a.spreadsheet_id && a.spreadsheet_id !== boardId) || a.spreadsheet_url) {
    fail("INVALID_REQUEST", "This adapter is restricted to the configured Agent Tasks boardId.");
  }
  const allowed = {
    get_range: ["spreadsheet_id", "sheet_name", "range", "value_render_option"],
    get_cells: ["spreadsheet_id", "ranges", "cell_fields"],
    get_metadata: ["spreadsheet_id", "charts_only", "include_conditional_format_rules"],
    batch_update: ["spreadsheet_id", "requests", "include_spreadsheet_in_response", "response_include_grid_data", "response_ranges"],
  }[op];
  if (Object.keys(a).some(k => !allowed.includes(k))) {
    fail("INVALID_REQUEST", "Unsupported board argument.");
  }
  if (op === "get_range") {
    const sheet = normalizeTab(a.sheet_name, allowedTabs);
    validateRectangle(a.range);
    if (
      a.value_render_option !== undefined &&
      a.value_render_option !== null &&
      !["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"].includes(a.value_render_option)
    ) {
      fail("INVALID_REQUEST", "Unknown value rendering option.");
    }
    a.sheet_name = sheet;
  }
  if (op === "get_cells") {
    if (!Array.isArray(a.ranges) || a.ranges.length < 1 || a.ranges.length > 20) {
      fail("INVALID_REQUEST", "Use bounded cell ranges.");
    }
    a.ranges.forEach(r => validateFullRange(r, allowedTabs));
  }
  if (op === "batch_update") {
    if (options.readOnly === true) {
      fail("READ_ONLY_MODE", "This board adapter is configured read-only.");
    }
    if (options.allowWrites !== true) {
      fail("WRITES_DISABLED", "Board writes require explicit allowWrites.");
    }
    validateWrite(a.requests);
    if (a.response_ranges) a.response_ranges.forEach(r => validateFullRange(r, allowedTabs));
  }
  return deepFreeze({ operation: op, arguments: { ...a, spreadsheet_id: boardId } });
}

function base64Url(input) {
  return Buffer.from(input).toString("base64url");
}

function createServiceAccountTokenProvider({
  serviceAccountPath,
  serviceAccount,
  scope = SCOPES.readOnly,
  tokenUri,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = 10000,
}) {
  if (typeof fetchImpl !== "function") fail("CONFIG_REQUIRED", "Global fetch or fetchImpl is required.");
  let cachedSa = serviceAccount ? structuredClone(serviceAccount) : null;
  let cachedToken = null;
  let expiresAtMs = 0;
  let inflight = null;

  function loadServiceAccount() {
    if (cachedSa) return cachedSa;
    if (!serviceAccountPath) fail("CONFIG_REQUIRED", "Provide serviceAccountPath or serviceAccount.");
    const raw = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));
    if (!raw?.client_email || !raw?.private_key) {
      fail("INVALID_CREDENTIALS", "Service account JSON must contain client_email and private_key.");
    }
    cachedSa = raw;
    return cachedSa;
  }

  async function refresh() {
    const sa = loadServiceAccount();
    const iat = Math.floor(now() / 1000);
    const exp = iat + 3600;
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64Url(
      JSON.stringify({
        iss: sa.client_email,
        scope,
        aud: tokenUri || sa.token_uri || "https://oauth2.googleapis.com/token",
        iat,
        exp,
      })
    );
    const unsigned = `${header}.${claims}`;
    const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), sa.private_key).toString("base64url");
    const assertion = `${unsigned}.${signature}`;

    const endpoint = tokenUri || sa.token_uri || "https://oauth2.googleapis.com/token";
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    });
    const res = await fetchImpl(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const text = await res.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = null; }
    if (!res.ok || !payload?.access_token) {
      fail("AUTH_ERROR", safeMessage(`OAuth token exchange failed (${res.status}): ${payload?.error_description || payload?.error || text}`));
    }
    const ttlSec = Math.max(60, Number(payload.expires_in) || 3600);
    cachedToken = payload.access_token;
    expiresAtMs = now() + (ttlSec - 60) * 1000;
    return cachedToken;
  }

  return async function getAccessToken() {
    if (cachedToken && now() < expiresAtMs) return cachedToken;
    if (!inflight) {
      inflight = refresh().finally(() => { inflight = null; });
    }
    return inflight;
  };
}

function createGoogleApiFetch({ getToken, fetchImpl, timeoutMs }) {
  return async function apiFetch(url, { method = "GET", body } = {}) {
    const token = await getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method,
        redirect: "error",
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        fail("SHEETS_HTTP_ERROR", safeMessage(`Google API ${res.status}: ${text}`));
      }
      if (!text.trim()) return {};
      try {
        return JSON.parse(text);
      } catch {
        return { content: text };
      }
    } catch (err) {
      if (err instanceof BoardAdapterError) throw err;
      if (err?.name === "AbortError") fail("HTTP_TIMEOUT", `Google API request timed out after ${timeoutMs}ms.`);
      fail("HTTP_ERROR", safeMessage(err?.message || "Network error contacting Google API."));
    } finally {
      clearTimeout(timer);
    }
  };
}

function createSheetsBoardAdapter(options = {}) {
  const boardId = validateBoardId(options.boardId);
  const readOnly = options.readOnly !== false;
  const scope = readOnly ? SCOPES.readOnly : SCOPES.readWrite;
  const sheetsBaseUrl = (options.sheetsBaseUrl || "https://sheets.googleapis.com/v4").replace(/\/+$/, "");
  const driveBaseUrl = (options.driveBaseUrl || "https://www.googleapis.com/drive/v3").replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") fail("CONFIG_REQUIRED", "Global fetch or fetchImpl is required.");
  const timeoutMs = options.timeoutMs || 10000;

  const getToken =
    options.tokenProvider ||
    createServiceAccountTokenProvider({
      serviceAccountPath: options.serviceAccountPath,
      serviceAccount: options.serviceAccount,
      scope,
      tokenUri: options.tokenUri,
      fetchImpl,
      now: options.now,
    });

  let sheetIdMap = options.sheetIdMap ? { ...options.sheetIdMap } : null;

  const apiFetch = createGoogleApiFetch({ getToken, fetchImpl, timeoutMs });

  async function resolveLiveSheetIdMap() {
    if (sheetIdMap) return sheetIdMap;
    const url = `${sheetsBaseUrl}/spreadsheets/${boardId}?fields=sheets.properties(sheetId,title)`;
    const meta = await apiFetch(url);
    const map = {};
    for (const s of meta?.sheets || []) {
      const title = s?.properties?.title;
      const id = s?.properties?.sheetId;
      if (typeof title === "string" && Number.isInteger(id)) map[title] = id;
    }
    sheetIdMap = map;
    return sheetIdMap;
  }

  function mapWriteRequests(requests, idMap) {
    return requests.map(req => {
      const key = req.updateCells ? "updateCells" : "appendCells";
      const inner = structuredClone(req[key]);
      const logicalId = inner.range ? inner.range.sheetId : inner.sheetId;
      const tabName = SHEET_ID_TO_TAB[logicalId];
      const realSheetId = tabName && Number.isInteger(idMap?.[tabName]) ? idMap[tabName] : logicalId;
      if (inner.range) inner.range.sheetId = realSheetId;
      else inner.sheetId = realSheetId;
      return { [key]: inner };
    });
  }

  async function call(request, controls = {}) {
    const prepared = prepareRequest(request, {
      boardId,
      protocolFileId: options.protocolFileId,
      allowedTabs: options.allowedTabs,
      readOnly,
      allowWrites: controls.allowWrites === true,
    });
    const op = prepared.operation;
    const a = prepared.arguments;

    if (op === "get_range") {
      const a1 = formatA1Range(a.sheet_name, a.range);
      const params = new URLSearchParams();
      if (a.value_render_option) params.set("valueRenderOption", a.value_render_option);
      const qs = params.toString();
      const url = `${sheetsBaseUrl}/spreadsheets/${boardId}/values/${encodeURIComponent(a1)}${qs ? `?${qs}` : ""}`;
      const data = await apiFetch(url);
      return {
        range: data.range || a1,
        values: Array.isArray(data.values) ? data.values : [],
      };
    }

    if (op === "get_cells") {
      const params = new URLSearchParams({ includeGridData: "true" });
      for (const range of a.ranges) params.append("ranges", range);
      params.set("fields", "sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(userEnteredValue,formattedValue,dataValidation))))");
      const url = `${sheetsBaseUrl}/spreadsheets/${boardId}?${params.toString()}`;
      return apiFetch(url);
    }

    if (op === "get_metadata") {
      const params = new URLSearchParams({ includeGridData: "false" });
      if (a.include_conditional_format_rules) params.set("fields", "spreadsheetId,properties,sheets");
      else params.set("fields", "spreadsheetId,properties,sheets.properties");
      const url = `${sheetsBaseUrl}/spreadsheets/${boardId}?${params.toString()}`;
      return apiFetch(url);
    }

    if (op === "get_protocol") {
      if (typeof options.protocolReader === "function") {
        return options.protocolReader(a.fileId);
      }
      if (!a.fileId) return { content: "" };
      const url = `${driveBaseUrl}/files/${a.fileId}?alt=media`;
      const data = await apiFetch(url);
      return typeof data === "string" ? { content: data } : data;
    }

    if (op === "batch_update") {
      const idMap = await resolveLiveSheetIdMap();
      const mapped = mapWriteRequests(a.requests, idMap);
      const url = `${sheetsBaseUrl}/spreadsheets/${boardId}:batchUpdate`;
      return apiFetch(url, {
        method: "POST",
        body: {
          requests: mapped,
          ...(a.include_spreadsheet_in_response !== undefined ? { includeSpreadsheetInResponse: a.include_spreadsheet_in_response } : {}),
          ...(a.response_include_grid_data !== undefined ? { responseIncludeGridData: a.response_include_grid_data } : {}),
          ...(a.response_ranges !== undefined ? { responseRanges: a.response_ranges } : {}),
        },
      });
    }

    fail("INVALID_REQUEST", "Unsupported board operation.");
  }

  return { call, readOnly, boardId };
}

/** Private app transport for deliberate owner actions. The agent adapter stays unchanged. */
function createOwnerSheetTransport(options = {}) {
  const boardId = validateBoardId(options.boardId);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs || 10000;
  const getToken = options.tokenProvider || createServiceAccountTokenProvider({
    serviceAccountPath: options.serviceAccountPath,
    tokenUri: "https://oauth2.googleapis.com/token",
    scope: SCOPES.readWrite,
    fetchImpl,
    timeoutMs,
  });
  const reader = createSheetsBoardAdapter({ ...options, boardId, readOnly: true, tokenProvider: getToken });
  const sheetsBaseUrl = (options.sheetsBaseUrl || "https://sheets.googleapis.com/v4").replace(/\/+$/, "");
  const apiFetch = createGoogleApiFetch({ getToken, fetchImpl, timeoutMs });
  const batch = requests => apiFetch(sheetsBaseUrl + "/spreadsheets/" + boardId + ":batchUpdate", {
    method: "POST", body: { requests },
  });
  const literal = stringValue => ({ userEnteredValue: { stringValue } });

  return {
    getMetadata: () => reader.call({ operation: "get_metadata", arguments: {} }),
    async readRange(sheetName, range) {
      const tab = normalizeTab(sheetName, new Set(["Tasks", "Done"]));
      validateRectangle(range);
      const a1 = formatA1Range(tab, range);
      const data = await apiFetch(sheetsBaseUrl + "/spreadsheets/" + boardId + "/values/" +
        encodeURIComponent(a1) + "?valueRenderOption=FORMATTED_VALUE");
      if (typeof data.range !== "string" || data.majorDimension !== "ROWS" ||
          (data.values !== undefined && !Array.isArray(data.values))) {
        fail("SHEETS_INVALID_RESPONSE", "Google Sheets did not return a task range.");
      }
      return data.values || [];
    },
    appendRows: (sheetId, rows) => batch([{ appendCells: {
      sheetId, rows: rows.map(row => ({ values: row.map(literal) })), fields: "userEnteredValue",
    } }]),
    updateCells: (sheetId, rowIndex, cells) => batch(cells.map(({ column, value }) => ({ updateCells: {
      range: { sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: column, endColumnIndex: column + 1 },
      rows: [{ values: [literal(value)] }],
      fields: "userEnteredValue",
    } }))),
  };
}

module.exports = {
  DEFAULT_TABS,
  SCOPES,
  BoardAdapterError,
  safeMessage,
  prepareRequest,
  createServiceAccountTokenProvider,
  createSheetsBoardAdapter,
  createOwnerSheetTransport,
};
