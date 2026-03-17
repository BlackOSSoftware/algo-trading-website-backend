function normalizeString(value) {
  return String(value ?? "").trim();
}

function parseClockTime(value) {
  const raw = normalizeString(value);
  if (!raw) return null;

  const twentyFourHourMatch = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(raw);
  if (twentyFourHourMatch) {
    return {
      hour: Number(twentyFourHourMatch[1]),
      minute: Number(twentyFourHourMatch[2]),
      second: Number(twentyFourHourMatch[3] || 0),
    };
  }

  const twelveHourMatch =
    /^(0?[1-9]|1[0-2]):([0-5]\d)(?::([0-5]\d))?\s*([AaPp][Mm])$/.exec(raw);
  if (!twelveHourMatch) return null;

  let hour = Number(twelveHourMatch[1]) % 12;
  if (twelveHourMatch[4].toLowerCase() === "pm") {
    hour += 12;
  }

  return {
    hour,
    minute: Number(twelveHourMatch[2]),
    second: Number(twelveHourMatch[3] || 0),
  };
}

function formatClockTime(parts) {
  if (!parts) return "";
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function normalizeClockTime(value, fallback = "") {
  const parsed = parseClockTime(value);
  return parsed ? formatClockTime(parsed) : fallback;
}

function parseClockTimeToMinutes(value) {
  const parsed = parseClockTime(value);
  if (!parsed) return null;
  return parsed.hour * 60 + parsed.minute;
}

module.exports = {
  parseClockTime,
  formatClockTime,
  normalizeClockTime,
  parseClockTimeToMinutes,
};
