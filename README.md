# PFUI

Eine kleine, öffentliche Karte der aktuell gelisteten Veröffentlichungen nach § 40 Abs. 1a LFGB beim Verbraucherfenster Hessen. Sie umfasst auch andere Verstöße als Hygienemängel. Jeder Eintrag führt zur amtlichen Originalseite.

Die Grundkarte zeigt deutsche Ortsnamen, sofern die Kartendaten sie bereitstellen, und fällt sonst auf den lokalen Namen zurück.

## Bedienung

Die Karte füllt den Bildschirm. Suche, Standort, Umkreis und Kartensteuerung liegen als Glass-Flächen darüber. Das Info-Symbol zum Öffnen der Karteninformationen steht rechts neben dem Suchfeld. Auf Smartphones teilt sich die schmale, 44 Pixel hohe Ergebnisleiste die untere Zeile mit dem gleich hohen MapLibre-Info-Button. Die Liste öffnet sich darüber. Obere Felder und Buttons haben kompaktes vertikales Innenpadding. Auf Desktop steht die Ergebnisliste als schmale Seitenleiste; Suche und Filter teilen sich darunter eine Zeile. Der Name eines Listeneintrags zeigt dessen Standort auf der Karte, „Original ansehen“ öffnet die amtliche Seite.

Ab Zoomstufe 14 werden Cluster automatisch aufgelöst und sämtliche Namen im sichtbaren Kartenausschnitt eingeblendet. Beim Herauszoomen erscheinen wieder Cluster und einzeln antippbare Punkte. Liste und Tooltips zeigen das Veröffentlichungsdatum; Meldungen der letzten sieben Tage erscheinen rot, ältere orange. Ab sechs Monaten werden Meldungen grau als archiviert markiert. Archivdaten sind zunächst ausgeblendet und lassen sich über den grün markierten Archivknopf einblenden. Einträge mit identischen Koordinaten stehen untereinander. Ziehen, Pinch-Gesten und Doppeltippen auf Tooltips steuern die Karte; Antippen des Pfeils öffnet die Originalseite.

Ort oder PLZ eingeben, „Suchen“ drücken und einen Treffer auswählen. Alternativ das Standort-Icon verwenden. Anschließend lässt sich der Umkreis über die Kilometer-Auswahl ändern. „Alle“ setzt die Standortfilterung zurück. Die Lupe im Rahmen sucht in der aktuellen Kartenansicht, ohne die Karte zu bewegen. Nach Verschieben oder Zoomen erneut drücken, um den neuen Ausschnitt abzufragen. Erfolgreich angewendete Suchbereiche werden durch farbige Bedienelemente angezeigt. Tastaturbedienung, reduzierte Animationen und eine deckendere Darstellung ohne Unterstützung für Hintergrundunschärfe werden berücksichtigt.

## Start

1. `.env.example` nach `.env` kopieren und eigene `PUBLIC_BASE_URL`- und `AUTHENTIK_ISSUER`-Werte sowie die Authentik-Clientdaten eintragen. `.env` bleibt lokal.
2. Das externe Docker-Netz `proxy` und das Volume `pfui-data` (`docker volume create pfui-data`) sowie einen NPM-Proxy-Host für die eigene `PUBLIC_BASE_URL` bereitstellen.
3. `docker compose up -d --build` ausführen. Die App läuft im Containernetz auf Port 3000; sie veröffentlicht keinen Host-Port.
4. `docker compose ps` und `https://pfui.example.com/api/v1/status` prüfen. Die Beispiel-Domain durch die eigene `PUBLIC_BASE_URL` ersetzen. Der erste Datenabruf kann einige Minuten dauern.

Die App speichert ihren SQLite-Stand im Docker-Volume `pfui-data`. Beim Start und anschließend täglich um 03:00 Uhr Europe/Berlin wird synchronisiert. Fehlgeschlagene Quellabrufe ändern den letzten gültigen Stand nicht.

## Schnittstellen

- `GET /api/v1/publications.geojson`: Alle Einträge oder gefiltert mit `bbox=west,süd,ost,nord` beziehungsweise `lat`, `lon`, `radius_km` (maximal 100 km).
- `GET /api/v1/publications/{id}`: Ein aktueller Eintrag.
- `GET /api/v1/status`: Datenalter, Anzahl und Fehlerstatus.
- `POST /mcp`: Lesende MCP-Werkzeuge nach OAuth-Anmeldung. Der Server veröffentlicht OAuth-Metadaten unter `/.well-known/`.

Die API ist öffentlich und gibt `Access-Control-Allow-Origin: *` aus. Das ermöglicht die spätere Einbindung als dynamische Wanderer-POI-Kategorie. Wanderer wird von diesem Projekt nicht verändert.

Die Authentik-Vorlage liegt unter `deploy/authentik/pfui.example.yaml`. Für den produktiven Einsatz eine lokale Kopie `deploy/authentik/pfui.local.yaml` erstellen und deren Callback- und Launch-URLs auf die eigene `PUBLIC_BASE_URL` setzen. Lokale Dateien und Produktivdaten werden ignoriert.

## Entwicklung

`npm ci`, `npm test` und `npm run build`. Weitere Details zu Synchronisation, OAuth und Betrieb stehen in [docs/architecture.md](docs/architecture.md). Die manuelle Oberflächenabnahme ist in [docs/web-ui.md](docs/web-ui.md) beschrieben.
