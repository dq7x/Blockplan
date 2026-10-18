#!/bin/sh
# Startet Blockplan Live (macOS / Linux). Einmalig ausführbar machen: chmod +x start.sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js wurde nicht gefunden. Installiere die LTS-Version von https://nodejs.org und starte erneut."
  exit 1
fi
( sleep 2; (command -v xdg-open >/dev/null && xdg-open http://localhost:8765) || (command -v open >/dev/null && open http://localhost:8765) ) >/dev/null 2>&1 &
exec node server.js "$@"
