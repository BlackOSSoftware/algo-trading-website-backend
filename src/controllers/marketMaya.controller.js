const { parseBody } = require("../utils/body");
const { sendJson } = require("../utils/response");
const { createHttpError } = require("../utils/httpError");
const { sendTelegramText, getActiveSubscribersForUser } = require("../services/telegram.service");
const {
  customTrade,
  getCallHistory,
  getSymbolPosition,
} = require("../services/marketMaya.service");

function normalizeString(value) {
  const trimmed = String(value || "").trim();
  return trimmed;
}

function isTruthy(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (value == null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function formatTradeNotification({ title, params, result }) {
  const exchange = normalizeString(params.exchange).toUpperCase();
  const segment = normalizeString(params.segment).toUpperCase();
  const callType = normalizeString(params.call_type).toUpperCase();
  const symbol = normalizeString(params.symbol);
  const symbolCode = normalizeString(params.symbol_code);
  const mode = result?.dryRun ? "DRY-RUN" : "LIVE";
  const status = result?.ok ? "SUCCESS" : "FAILED";

  return [
    `${title}: ${callType || "TRADE"} ${symbol || symbolCode || ""}`.trim(),
    exchange || segment ? `Market: ${[exchange, segment].filter(Boolean).join(" · ")}` : null,
    `Mode: ${mode}`,
    `Status: ${status}`,
    !result?.ok && result?.error ? `Error: ${result.error}` : null,
    `Time: ${new Date().toISOString()}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function notifyUserTrades(userId, text) {
  if (!userId || !text) return;
  const subscribers = await getActiveSubscribersForUser(String(userId));
  if (!subscribers || subscribers.length === 0) return;
  const tasks = subscribers
    .filter((sub) => sub?.chatId)
    .map((sub) => sendTelegramText(String(sub.chatId), text).catch(() => {}));
  await Promise.allSettled(tasks);
}

function readFirst(body, keys) {
  for (const key of keys) {
    if (body && Object.prototype.hasOwnProperty.call(body, key)) {
      const value = body[key];
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function pickTradeParams(body) {
  const allowed = [
    "exchange",
    "symbol_code",
    "segment",
    "symbol",
    "contract",
    "expiry",
    "expiry_date",
    "option_type",
    "atm",
    "strike_price",
    "call_type",
    "qty_distribution",
    "qty_value",
    "target_by",
    "target",
    "sl_by",
    "sl",
    "is_trail_sl",
    "sl_move",
    "profit_move",
  ];

  const params = {};
  allowed.forEach((key) => {
    const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const value = readFirst(body, [key, camel]);
    if (value !== undefined) {
      params[key] = value;
    }
  });
  return params;
}

function normalizeTradeParams(params) {
  const normalized = { ...(params || {}) };

  if (normalized.exchange !== undefined) {
    normalized.exchange = normalizeString(normalized.exchange).toUpperCase();
  }

  if (normalized.call_type !== undefined) {
    normalized.call_type = normalizeString(normalized.call_type).toUpperCase();
  }

  if (!isTruthy(normalized.is_trail_sl)) {
    delete normalized.is_trail_sl;
  }

  const symbolCode = normalizeString(normalized.symbol_code);
  if (symbolCode) {
    normalized.symbol_code = symbolCode;
    delete normalized.segment;
    delete normalized.symbol;
    delete normalized.contract;
    delete normalized.expiry;
    delete normalized.expiry_date;
    delete normalized.option_type;
    delete normalized.atm;
    delete normalized.strike_price;
    return normalized;
  }

  const segment = normalizeString(normalized.segment).toUpperCase();
  if (segment) {
    normalized.segment = segment;
  }

  const symbol = normalizeString(normalized.symbol);
  if (symbol) {
    normalized.symbol = symbol.toUpperCase();
  }

  if (normalized.contract !== undefined) {
    normalized.contract = normalizeString(normalized.contract).toUpperCase();
  }

  if (normalized.expiry !== undefined) {
    normalized.expiry = normalizeString(normalized.expiry).toUpperCase();
  }

  if (segment === "EQ") {
    delete normalized.contract;
    delete normalized.expiry;
    delete normalized.expiry_date;
    delete normalized.option_type;
    delete normalized.atm;
    delete normalized.strike_price;
    return normalized;
  }

  if (segment === "FUT") {
    delete normalized.option_type;
    delete normalized.atm;
    delete normalized.strike_price;

    const expiryDate = normalizeString(normalized.expiry_date);
    if (expiryDate) {
      normalized.expiry_date = expiryDate;
      delete normalized.contract;
      delete normalized.expiry;
    }

    return normalized;
  }

  if (segment === "OPT") {
    const expiryDate = normalizeString(normalized.expiry_date);
    if (expiryDate) {
      normalized.expiry_date = expiryDate;
      delete normalized.contract;
      delete normalized.expiry;
    }

    if (normalized.option_type !== undefined) {
      const optionType = normalizeString(normalized.option_type).toUpperCase();
      normalized.option_type = optionType;
    }

    const strike = normalizeString(normalized.strike_price);
    const atm = normalizeString(normalized.atm);
    if (strike) {
      normalized.strike_price = strike;
      delete normalized.atm;
    } else if (atm) {
      normalized.atm = atm;
      delete normalized.strike_price;
    }

    return normalized;
  }

  return normalized;
}

function validateTradeParams(params) {
  const exchange = normalizeString(params.exchange);
  const callType = normalizeString(params.call_type);
  const symbolCode = normalizeString(params.symbol_code);
  const segment = normalizeString(params.segment).toUpperCase();
  const symbol = normalizeString(params.symbol);

  if (!exchange) {
    throw createHttpError(400, "exchange is required");
  }

  if (!callType) {
    throw createHttpError(400, "call_type is required");
  }

  if (symbolCode) {
    return;
  }

  if (!segment) {
    throw createHttpError(400, "segment is required when symbol_code is not provided");
  }

  if (!symbol) {
    throw createHttpError(400, "symbol is required when symbol_code is not provided");
  }

  if (segment === "FUT" || segment === "OPT") {
    const contract = normalizeString(params.contract);
    const expiry = normalizeString(params.expiry);
    const expiryDate = normalizeString(params.expiry_date);
    if (!expiryDate && (!contract || !expiry)) {
      throw createHttpError(
        400,
        "contract + expiry (or expiry_date) is required for FUT/OPT"
      );
    }
  }

  if (segment === "OPT") {
    const optionType = normalizeString(params.option_type);
    const atm = normalizeString(params.atm);
    const strike = normalizeString(params.strike_price);
    if (!optionType) {
      throw createHttpError(400, "option_type is required for OPT");
    }
    if (!atm && !strike) {
      throw createHttpError(400, "atm or strike_price is required for OPT");
    }
  }
}

async function trade(req, res) {
  const userId = req.user?.sub;
  if (!userId) {
    throw createHttpError(401, "Unauthorized");
  }

  const body = await parseBody(req);
  const token = normalizeString(readFirst(body, ["token", "marketMayaToken", "marketmayaToken"]));
  const execute = readFirst(body, ["execute"]);
  const params = normalizeTradeParams(pickTradeParams(body));

  validateTradeParams(params);

  const result = await customTrade({ token, params, execute });
  if (!result.ok && result.dryRun && result.error) {
    throw createHttpError(400, result.error);
  }

  sendJson(res, 200, result);

  if (isTruthy(execute) && !result.dryRun) {
    setImmediate(() => {
      const text = formatTradeNotification({
        title: "MANUAL TRADE",
        params,
        result,
      });
      notifyUserTrades(userId, text).catch(() => {});
    });
  }
}

async function tradeAdmin(req, res) {
  const adminId = req.user?.sub;
  if (!adminId) {
    throw createHttpError(401, "Unauthorized");
  }

  const body = await parseBody(req);
  const notifyUserId = normalizeString(readFirst(body, ["notifyUserId", "userId"]));
  const token = normalizeString(readFirst(body, ["token", "marketMayaToken", "marketmayaToken"]));
  const execute = readFirst(body, ["execute"]);
  const params = normalizeTradeParams(pickTradeParams(body));

  validateTradeParams(params);

  const result = await customTrade({ token, params, execute });
  if (!result.ok && result.dryRun && result.error) {
    throw createHttpError(400, result.error);
  }

  sendJson(res, 200, result);

  if (notifyUserId && isTruthy(execute) && !result.dryRun) {
    setImmediate(() => {
      const text = formatTradeNotification({
        title: "ADMIN TRADE",
        params,
        result,
      });
      notifyUserTrades(notifyUserId, text).catch(() => {});
    });
  }
}

async function callHistory(req, res) {
  const userId = req.user?.sub;
  if (!userId) {
    throw createHttpError(401, "Unauthorized");
  }

  const body = await parseBody(req);
  const token = normalizeString(readFirst(body, ["token", "marketMayaToken", "marketmayaToken"]));
  const execute = readFirst(body, ["execute"]);

  const result = await getCallHistory({ token, execute });
  if (!result.ok && result.dryRun && result.error) {
    throw createHttpError(400, result.error);
  }

  sendJson(res, 200, result);
}

async function callHistoryAdmin(req, res) {
  const adminId = req.user?.sub;
  if (!adminId) {
    throw createHttpError(401, "Unauthorized");
  }

  const body = await parseBody(req);
  const token = normalizeString(readFirst(body, ["token", "marketMayaToken", "marketmayaToken"]));
  const execute = readFirst(body, ["execute"]);

  const result = await getCallHistory({ token, execute });
  if (!result.ok && result.dryRun && result.error) {
    throw createHttpError(400, result.error);
  }

  sendJson(res, 200, result);
}

async function symbolPosition(req, res) {
  const userId = req.user?.sub;
  if (!userId) {
    throw createHttpError(401, "Unauthorized");
  }

  const body = await parseBody(req);
  const token = normalizeString(readFirst(body, ["token", "marketMayaToken", "marketmayaToken"]));
  const execute = readFirst(body, ["execute"]);

  const result = await getSymbolPosition({ token, execute });
  if (!result.ok && result.dryRun && result.error) {
    throw createHttpError(400, result.error);
  }

  sendJson(res, 200, result);
}

async function symbolPositionAdmin(req, res) {
  const adminId = req.user?.sub;
  if (!adminId) {
    throw createHttpError(401, "Unauthorized");
  }

  const body = await parseBody(req);
  const token = normalizeString(readFirst(body, ["token", "marketMayaToken", "marketmayaToken"]));
  const execute = readFirst(body, ["execute"]);

  const result = await getSymbolPosition({ token, execute });
  if (!result.ok && result.dryRun && result.error) {
    throw createHttpError(400, result.error);
  }

  sendJson(res, 200, result);
}

module.exports = {
  trade,
  tradeAdmin,
  callHistory,
  callHistoryAdmin,
  symbolPosition,
  symbolPositionAdmin,
};
