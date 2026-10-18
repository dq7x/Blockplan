BLOCKPLAN LIVE
==============

Vorlagen (.litematic, .schem, .nbt) in 3D ansehen, live mit deiner Minecraft-Welt
vergleichen und als /fill-Befehle oder Datapack bauen.

Voll ausfuehrliche Anleitung: README.md im GitHub-Repository.

START
1. Node.js (LTS) installieren: https://nodejs.org   (einmalig)
2. Windows:       Doppelklick auf start.bat
   macOS / Linux: im Terminal ./start.sh   (einmalig: chmod +x start.sh)
3. Der Browser oeffnet http://localhost:8765. Das Fenster dahinter offen lassen.
   Beenden mit Strg+C.

KURZ BENUTZEN
1. "Vorlage oeffnen" oder Datei in das Fenster ziehen.
2. Rechts bei "Live-Abgleich" deine Welt waehlen, bei "Startpunkt" die Eckkoordinaten
   (kleinste X-, Y-, Z-Werte) eintragen. Im Spiel mit F3 ablesbar.
3. Tab "Befehle": Datapack in die Welt schreiben, im Spiel /reload, dann
   /function blockplan:build_001 (bei mehreren Dateien der Reihe nach).

WICHTIG
- Minecraft schreibt die Welt nur beim Speichern. /save-all erzwingt es (Cheats noetig).
- Das Programm liest deine Welt nur. Einzige Ausnahme: "In Welt schreiben" im Tab
  Befehle schreibt ausschliesslich in <Welt>/datapacks/blockplan.
- Mach vor dem Bauen mit "Bereich vorher leeren" ein Backup deiner Welt.
- Gesucht wird automatisch in .minecraft, der Modrinth App und im Prism Launcher.
  Anderer Ordner:  node server.js --saves "C:\Pfad\zu\saves"
- Port belegt:    node server.js --port 8766
