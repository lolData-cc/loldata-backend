// src/server/season.ts
function parseEpochEnv(key: string): number | undefined {
  const raw = process.env[key];
  if (!raw) return undefined;

  // accetta sia secondi che millisecondi
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;

  // se è in ms (>= 1e12 circa), converti in sec
  const sec = n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
  return sec >= 0 ? sec : undefined;
}

export function getCurrentSeasonWindow() {
  const start = parseEpochEnv("SEASON_START_EPOCH"); // sec
  const end = parseEpochEnv("SEASON_END_EPOCH");     // sec (opzionale)

  // fallback (opzionale): se start mancante, NON forzare NaN
  // puoi decidere una finestra di default (es. ultimi 90 giorni) OPPURE lasciare undefined
  // qui scelgo di lasciarlo undefined così non rompi le query
  return {
    startTime: start, // undefined se non settato correttamente
    endTime: end,
  };
}
