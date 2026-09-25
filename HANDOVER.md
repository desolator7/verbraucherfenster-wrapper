# Technisches Handover: Verbraucherfenster-Hessen-Hygienemängelkarte

Stand: 2026-09-24

Dieses Dokument übergibt die bisher gewonnenen Erkenntnisse zur Karte der veröffentlichten Hygienemängel auf der Verbraucherfenster-Hessen-Seite. Es beschreibt den beobachteten Datenzugriff und eine mögliche Zielarchitektur für `verbraucherfenster-wrapper`. Die Angaben sind als Reverse-Engineering-Befund zu verstehen; die Website kann ihre aggregierten Assets oder ihr Markup später ändern.

## 1. Quelle und beobachtete Endpunkte

Ausgangsseite der Karte:

```text
https://verbraucherfenster.hessen.de/ernaehrung/sichere-lebensmittel/veroeffentlichung-maengel-lfgb?displayFirst=map_first
```

Bestätigter Detailendpunkt:

```text
https://verbraucherfenster.hessen.de/verbraucherfenster-get-details-for-id/{ID}
```

Beispiel:

```text
https://verbraucherfenster.hessen.de/verbraucherfenster-get-details-for-id/7066
```

Der Request funktioniert auch ohne Cookies, `Referer` oder `X-Requested-With`. Ein optionaler Query-Parameter wie `?_=timestamp` ist lediglich der von jQuery verwendete Cache-Buster; er ist kein Bestandteil der Datensatz-ID und für die fachliche Anfrage nicht erforderlich.

Der Detailendpunkt liefert das Popup-/HTML-Fragment zum Eintrag. Er liefert nach dem bisherigen Befund nicht die Kartenkoordinaten. Koordinaten müssen daher aus dem Kartendatensatz (`allPoints`) übernommen werden.

## 2. Technischer Seitenaufbau

Die Seite ist Drupal-basiert. JavaScript wird unter anderem als aggregierte Datei ausgeliefert, typischerweise unter:

```text
/sites/verbraucherfenster.hessen.de/files/js/...
```

Die beobachtete Client-Kette beim Öffnen eines Karteneintrags ist:

```text
infoItemUpdate()
  -> jQuery.ajax()
     -> Browser-XHR
        -> /verbraucherfenster-get-details-for-id/{ID}
```

Für eine Implementierung sollte deshalb nicht von einem stabilen Dateinamen der aggregierten JS-Datei ausgegangen werden. Die aktuellen `<script src="...">`-URLs sollten von der Ausgangsseite entdeckt werden. Bei Änderungen am Drupal-Aggregator können sich Pfade und Dateinamen ändern, während die fachliche Datenstruktur gleich bleibt.

## 3. Entscheidender Kartenbefund: `he_config.allPoints`

Im JavaScript-Kontext wurde `he_config.allPoints` gefunden. Die Struktur ist GeoJSON-artig: eine Liste von Point-Features, die bereits die benötigten Kartenkoordinaten enthält. Eine externe Geocodierung ist deshalb nicht nötig, sofern diese Liste zuverlässig extrahiert werden kann.

Beobachtete Struktur:

```json
{
  "type": "Feature",
  "geometry": {
    "type": "Point",
    "coordinates": ["8.4692718", "50.9228769"]
  },
  "properties": {
    "name": "35216",
    "description": "7266",
    "rendered_entity": "Imbissbetrieb \"Pizzeria Latina\""
  }
}
```

Feldzuordnung:

| Feld | Bedeutung | Normalisierung |
| --- | --- | --- |
| `geometry.type` | Geometrietyp | `Point` erwarten, sonst prüfen/ignorieren |
| `geometry.coordinates[0]` | Longitude | String mit `Number(...)` in Zahl umwandeln |
| `geometry.coordinates[1]` | Latitude | String mit `Number(...)` in Zahl umwandeln |
| `properties.name` | Postleitzahl | als String behandeln, führende Nullen erhalten |
| `properties.description` | interne Datensatz-/Veröffentlichungs-ID | als Primärschlüssel behandeln; Rohwert erhalten |
| `properties.rendered_entity` | Betriebsname | als Anzeige-/Fallbackname verwenden |

Wichtige Beispiele aus dem beobachteten Datensatz:

| ID (`properties.description`) | Betriebsname | Koordinaten `[lon, lat]` |
| --- | --- | --- |
| `7292` | Hikari | `[8.6073293, 49.8923338]` |
| `7287` | Imbiss Asia Home | `[8.7737399, 50.7887965]` |
| `7266` | Imbissbetrieb „Pizzeria Latina“ | `[8.4692718, 50.9228769]` |

Koordinaten sind nicht eindeutig: Mehrere verschiedene Einträge können am selben Ort liegen. Die Datensatz-ID ist daher der Primärschlüssel; niemals nur nach Koordinaten deduplizieren. Auch gleiche Betriebsnamen oder gleiche PLZ dürfen nicht als Identität verwendet werden.

Die Liste ist nahezu eine GeoJSON-`FeatureCollection`. Für einen Export genügt sinngemäß ein Wrapper mit numerischen Koordinaten:

```js
{
  type: "FeatureCollection",
  features: allPoints.map(feature => ({
    ...feature,
    geometry: {
      ...feature.geometry,
      coordinates: feature.geometry.coordinates.map(Number)
    }
  }))
}
```

## 4. Einschränkung bei der Extraktion

`he_config` war im beobachteten Ausführungskontext vorhanden, aber nicht dauerhaft global verfügbar. Nach dem Fortsetzen des Debuggers schlugen beispielsweise `he_config.allPoints.length` und `Object.keys(he_config)` in der normalen Console mit `ReferenceError: he_config is not defined` fehl.

Daraus folgt:

- Der Name allein reicht nicht für einen normalen globalen Zugriff.
- `he_config` liegt wahrscheinlich in einem lokalen Scope bzw. einer Closure der Karteninitialisierung.
- Eine im Breakpoint gesetzte Referenz wie `window.myHygienePoints = structuredClone(he_config.allPoints)` funktioniert nur während dieses lokalen Debugger-Kontexts und muss für den produktiven Wrapper durch eine belastbare Extraktion ersetzt werden.
- Die Gesamtzahl der Features wurde bisher nicht verlässlich dauerhaft bestätigt. Eine vermutete Anzahl darf nicht als feste Datenmenge implementiert werden.

Zu prüfende Extraktionswege, in dieser Reihenfolge:

1. Die von der Ausgangsseite referenzierten aggregierten JavaScript-Dateien laden und nach `he_config`, `allPoints` sowie den Feature-Literalen suchen.
2. Falls die Daten erst während der Karteninitialisierung entstehen, die betreffende Funktion/Closure instrumentieren und die Liste beim Erzeugen der Marker abgreifen.
3. Als Fallback die XHR-/jQuery-Aufrufe beobachten, um IDs und Detailfragmente zu erfassen; das ersetzt aber nicht die Koordinatenextraktion, weil der Detailendpunkt selbst keine Koordinaten liefert.

Der Parser sollte Änderungen an Whitespace, String-Quoting und Drupal-Aggregatdateinamen tolerieren und die Rohdaten für spätere Fehlersuche speichern. Unkontrolliertes Ausführen fremden JavaScript ist für einen Server-Scraper zu vermeiden; bevorzugt werden ein begrenzter Parser oder eine isolierte, nachvollziehbare Instrumentierung.

## 5. Vorgeschlagene Zielarchitektur für `verbraucherfenster-wrapper`

```text
Ausgangsseite abrufen
        |
        v
aktuelle JS-Assets entdecken und allPoints/IDs extrahieren
        |
        v
Snapshot nach ID bilden und Änderungen erkennen
        |
        v
Detailendpunkt je neuer/geänderter ID abrufen
        |
        v
Detail-HTML + Kartenfeature in eigenes Datenmodell normalisieren
        |
        +--> GeoJSON/API für Leaflet oder MapLibre
        |
        +--> Rohsnapshot/Status für Synchronisation und Debugging
```

Empfohlenes minimales internes Modell:

```text
id                 string             Primärschlüssel aus properties.description
postalCode         string | null      properties.name
businessName       string | null      properties.rendered_entity
longitude          number             geometry.coordinates[0]
latitude           number             geometry.coordinates[1]
detailHtml         string | null      Antwort des Detailendpunkts
sourceUrl          string             Original-/Detail-Link
firstSeenAt        timestamp
lastSeenAt         timestamp
featureHash        string             Erkennung von Kartenänderungen
detailFetchedAt    timestamp | null
```

Rohfeature und Rohantwort sollten zusätzlich aufbewahrt werden, damit Änderungen am Quellformat nachvollziehbar bleiben. `detailHtml` sollte vor der Ausgabe an einen Browser auf erlaubte HTML-Elemente und sichere URLs beschränkt bzw. sanitisiert werden.

## 6. Synchronisation

Die Synchronisation sollte nicht nur neue Einträge anhängen:

1. Bei jedem Lauf die aktuelle `allPoints`-Menge lesen und nach ID indizieren.
2. Neue IDs anlegen und für sie das Detailfragment abrufen.
3. Bei geänderten Koordinaten, Namen, PLZ oder sonstigen Feature-Feldern das Feature aktualisieren und das Detailfragment erneut laden, soweit die Änderung eine neue Veröffentlichung erkennen lässt.
4. `lastSeenAt` für weiterhin vorhandene IDs aktualisieren.
5. IDs, die im aktuellen Snapshot fehlen, zeitnah aus dem aktiven Datenbestand entfernen oder entsprechend dem Produktentscheid als nicht mehr aktuell markieren. Sie dürfen nicht unbegrenzt auf der eigenen Karte verbleiben.
6. Fehler beim einzelnen Detailrequest getrennt protokollieren und den letzten gültigen Datensatz nicht stillschweigend mit leeren Feldern überschreiben.

Für Last und Stabilität sind Rate-Limit, Backoff und eine begrenzte Parallelität vorzusehen. Ein Snapshot-Hash kann unnötige Detailrequests vermeiden; die ID bleibt trotzdem die fachliche Identität.

## 7. Rechtlicher und redaktioneller Hinweis

Vor einer öffentlichen Vollspiegelung der Inhalte müssen Impressum, Nutzungsbedingungen und gegebenenfalls weitere Vorgaben der Quelle geprüft werden. Die eigene Oberfläche sollte den Original-Link je Eintrag sowie einen klaren Quellenhinweis auf Verbraucherfenster Hessen vorsehen. Bei der Umsetzung sind außerdem Abrufhäufigkeit, Cache-Dauer, Attributionsanforderungen und die Behandlung von entfernten bzw. geänderten Veröffentlichungen zu dokumentieren.

## 8. Nächste sinnvolle Schritte

1. Einen kleinen Read-only-Extractor für die aktuelle Ausgangsseite und ihre aggregierten JS-Assets bauen.
2. Mit den bekannten IDs `7292`, `7287`, `7266` und dem Detailtest `7066` gegen die erwartete Struktur testen.
3. Einen Testfall für gleiche Koordinaten mit unterschiedlichen IDs aufnehmen.
4. Das normalisierte GeoJSON und eine Detail-API definieren, bevor UI-Code entsteht.
5. Erst danach die laufende Synchronisation und die Leaflet-/MapLibre-Darstellung ergänzen.
