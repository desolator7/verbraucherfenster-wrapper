# Kartenoberfläche

Orts- und Gebietsnamen der Grundkarte erscheinen auf Deutsch, wenn ein deutscher Kartenname verfügbar ist; andernfalls verwendet die Karte den lokalen Namen.

Die Karte nutzt die volle verfügbare Höhe und berücksichtigt Safe Areas. Die oberen Felder und Buttons haben reduziertes vertikales Innenpadding bei mindestens 44 Pixel großen Touch-Flächen. Glass-Flächen bündeln Suche und Filter; bei fehlender Unterstützung für Hintergrundunschärfe sind die Flächen stärker deckend. Beim Bearbeiten des Suchfeldes passt sich die Höhe an den sichtbaren Bereich einschließlich Bildschirmtastatur an. Mobil werden dabei die übrigen Filter und die Ergebnisliste ausgeblendet, damit die Suchtreffer erreichbar bleiben.

## Ergebnisse und Tooltips

Unter 900 Pixel Breite ist die Ergebnisliste zunächst geschlossen. Ihre schmale Leiste steht links neben dem MapLibre-Info-Button; beide sind 44 Pixel hoch und schließen unten auf derselben Höhe ab. Der Pfeil neben der Anzahl öffnet und schließt das separat scrollbare Panel nach oben. Die Leiste bleibt dabei in der unteren Zeile. Die Kartenquellen öffnen sich oberhalb des Info-Buttons und verbreitern diese Zeile nicht. Das Info-Symbol zum Öffnen der Karteninformationen steht rechts neben dem Suchfeld. Suche und die fünf Filterelemente passen ab 900 Pixel in eine Zeile; auf Smartphones stehen Suche und Filter in zwei Zeilen. Liste und Tooltips zeigen das Veröffentlichungsdatum; fehlt es auf der amtlichen Detailseite, wird das kenntlich gemacht. Meldungen ohne gültiges Datum werden nicht archiviert. Die Namensschaltfläche eines Listeneintrags fokussiert den Standort; Links zu nicht archivierten Meldungen öffnen einen neuen Tab.

Unter Zoomstufe 14 zeigt ein Antippen eines einzelnen Punktes Name, Veröffentlichungsdatum und Pfeil-Link. Ein Klick auf die freie Karte oder Escape schließt dieses Popup. Cluster werden beim Antippen vergrößert. Meldungen der letzten sieben Kalendertage sind knallrot markiert, ältere orange; Meldungen ab sechs Kalendermonaten sind grau und zeigen ein Archivsymbol statt eines Links. Ein Cluster ist rot, wenn es mindestens eine neue Meldung enthält, und grau, wenn es ausschließlich archivierte Meldungen enthält.

Ab Zoomstufe 14 erscheinen automatisch ungeclusterte Punkte und dauerhafte Tooltips mit Name, Veröffentlichungsdatum und je nach Archivstatus Pfeil-Link oder Archivsymbol für alle Standorte im sichtbaren Kartenausschnitt. Beim Herauszoomen werden diese Tooltips entfernt und die Cluster wieder eingeblendet. Gleich positionierte Einträge stehen untereinander in einem gemeinsamen Tooltip. Lange Namen umbrechen. Unterschiedliche Standorte können sich überlagern. Der Archivknopf in der Filterzeile blendet archivierte Meldungen auf Karte, in Clustern und in der Ergebnisliste gemeinsam aus oder ein; sie sind anfangs sichtbar.

Ziehen, Pinch-Gesten und Doppeltippen auf einem Tooltip steuern die Karte. Doppeltippen auf Bedienelemente vergrößert die Karte an der Berührungsposition, ohne die gesamte Oberfläche zu zoomen. Auf Tooltips sind Browser-Zoom, Textauswahl und natives Ziehen von Links deaktiviert. Ein kurzes Antippen oder die Eingabetaste öffnet den Pfeil-Link weiterhin. Große Standortgruppen lassen sich über ihre Links per Tastatur durchlaufen; auf Touch-Geräten sind sämtliche Einträge auch über die Ergebnisliste erreichbar. Während einer Touch-Geste auf einem Tooltip bleiben dessen DOM-Knoten erhalten, damit das Entfernen oder Ersetzen eines Touch-Ziels die Geste nicht unterbricht. Zoomabhängige Tooltip-Wechsel erfolgen in diesem Fall nach dem Loslassen.

## Suchbereiche

- Standort-Icon: Standortfreigabe anfragen und nach Einträgen im gewählten Umkreis suchen.
- Kilometer-Auswahl: Radius um den gewählten Ort oder eigenen Standort ändern. Ohne Ortsbezug ist sie deaktiviert; eine sichtbare Beschriftung „Umkreis“ entfällt, die zugängliche Beschriftung bleibt erhalten.
- „Alle“: Filter zurücksetzen und die gesamte Hessen-Karte anzeigen.
- Archivsymbol: Archivierte Meldungen aus Karte, Clustern und Ergebnisliste aus- oder einblenden.
- Lupe im Rahmen: Den aktuellen Kartenausschnitt über die vorhandene `bbox`-Schnittstelle durchsuchen, ohne Zoom oder Position zu verändern. Dieser Filter ersetzt die Umkreissuche. Die Auswahl wird als Momentaufnahme abgefragt; Kartenbewegungen lösen keine automatischen Datenabrufe aus.

Farbige Bedienelemente kennzeichnen den erfolgreich geladenen Suchbereich: „Alle“, Standort und Radius, Ortssuche und Radius oder die Ansichtssuche. Nach einer Änderung des Kartenausschnitts verliert der Ansichtsbutton seine Aktivmarkierung, damit erkennbar ist, dass erneut gesucht werden kann. Der Archivknopf zeigt seinen aktivierten Zustand, wenn archivierte Meldungen ausgeblendet sind. Die bisherigen dauerhaften Statuszeilen für Hessen und Umkreis entfallen. Lade-, Leer- und Fehlermeldungen bleiben sichtbar, solange sie relevant sind.

Fehlgeschlagene Datenabrufe lassen die bisherige Ansicht stehen und kennzeichnen sie entsprechend. „Erneut laden“ wiederholt den Abruf. Auch bei schnell aufeinanderfolgenden Suchen und verspäteten Standortantworten darf nur die jüngste Anfrage ihre Ergebnisse anzeigen.

## Automatisierte Prüfung

`npm test` führt die Node-Tests aus. Die Frontend-Verhaltenstests prüfen die Gruppierung gleicher Koordinaten, stabile Tooltip-Identitäten und das Verwerfen verspäteter Ergebnisse und Fehler. `npm run build` erstellt die Produktionsdateien. Diese Prüfungen ersetzen keine visuelle Browserabnahme.

## Manuelle Abnahme durch den Betreiber

Smoke-, Playwright- und manuelle Browser-Abnahmetests werden bei diesem Umbau vom Betreiber übernommen. Folgende Szenarien sind dafür vorgesehen:

- Smartphone ab 320 Pixel Breite, Querformat und Desktop: keine horizontalen Überläufe, erreichbare Suche und Kartensteuerung, sichtbare Kartenquellenangaben.
- Smartphone mit eingeblendeter Tastatur: Suchfeld und lange Trefferlisten bleiben erreichbar; nach Ortswahl steht die Karte wieder zur Verfügung.
- Ergebnisliste öffnen, scrollen und schließen; einen Eintrag auf der Karte fokussieren und seine Originalseite öffnen. Auf Smartphones müssen Listenleiste und MapLibre-Info-Button in derselben 44 Pixel hohen Zeile stehen. Kartenquellen öffnen und schließen: Sie müssen darüber erscheinen, ohne die Listenleiste zu verschieben. Auch Breiten zwischen 641 und 899 Pixel sowie Safe Areas prüfen.
- Tooltips und Bedienelemente doppeltippen: Die Karte muss an der Berührungsposition zoomen, während die Oberfläche ihre Größe behält.
- Ortssuche mit Treffern, ohne Treffer und mit Fehler; zügig aufeinanderfolgende Suchen und Filterwechsel dürfen keine älteren Ergebnisse übernehmen.
- Standort erlauben, verweigern oder auslaufen lassen; danach manuell suchen. Eine verspätete Standortantwort darf eine neue Ortswahl oder „Ganz Hessen“ nicht ersetzen.
- Alle Umkreise und „Ganz Hessen“ ausprobieren; leere Datenmenge und fehlgeschlagenen Abruf einschließlich Wiederholung prüfen.
- Zoomstufe 14 in beide Richtungen überschreiten: Namen und Cluster müssen automatisch wechseln. Lange Namen, identische Koordinaten und viele Punkte prüfen. Dauerhafte Namen müssen bei Verschieben und Filterwechseln nachgeführt werden; beim Herauszoomen dürfen keine zurückbleiben.
- Auf Tooltip-Text und Pfeil ziehen und mit zwei Fingern zoomen, auch mit einem Finger auf der freien Karte: Nur die Karte darf sich bewegen beziehungsweise zoomen. Zoomstufe 14 während der Geste überschreiten. Nach dem Loslassen darf kein Link versehentlich öffnen; ein anschließendes kurzes Antippen und die Eingabetaste müssen den Link öffnen.
- Die Ansichtssuche nach einer Umkreissuche und nach „Ganz Hessen“ ausführen: Kamera unverändert, nur passende Einträge in Karte und Liste. Nach Kartenbewegung muss die Aktivmarkierung erlöschen; erneutes Suchen muss den neuen Ausschnitt übernehmen.
- Aktivfarben bei Ortswahl, Standort, Radiuswechsel, Hessen-Reset, Ansichtssuche und fehlgeschlagenem Abruf prüfen. Erfolgreiche Suchen dürfen keine dauerhafte Hessen-/Umkreis-Statuszeile anzeigen.
- Tastaturfokus, Escape, Über-Dialog und dessen Fokus-Rückkehr prüfen. Icon-Schaltflächen und Radius müssen zugänglich beschriftet sein; aktive Schaltflächen müssen ihren Zustand vermitteln.
- Reduzierte Bewegung im Betriebssystem und Darstellung ohne Hintergrundunschärfe prüfen.
