// src/server/season.ts
export function getCurrentSeasonWindow() {
  const start = Number(process.env.SEASON_START_EPOCH); 
  const end = process.env.SEASON_END_EPOCH ? Number(process.env.SEASON_END_EPOCH) : undefined;
  return { startTime: start, endTime: end };
}
