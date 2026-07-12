#!/bin/sh
# Nightly refresh of the champion Build-tab data:
#   1. rebuild the cbs_* summary tables from live participants (atomic swap)
#   2. repopulate the cbs_build_live L2 cache (warmBuild.ts)
# Installed as loldata-cbs-refresh.service, fired daily by the matching .timer.
set -e
echo "[cbs-refresh] $(date -u) — rebuilding stats summary tables"
docker exec -i supabase-db psql -U postgres -d postgres < /opt/loldata-backend/sql/refresh-cbs.sql
echo "[cbs-refresh] $(date -u) — stats swapped; warming build_live cache"
cd /opt/loldata-backend && /root/.bun/bin/bun run src/server/warmBuild.ts
echo "[cbs-refresh] $(date -u) — done"
