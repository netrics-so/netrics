import type { Catalog } from "@netrics/domain";

import type { apiErrorsEn } from "./en";

export const apiErrorsDe: Catalog<typeof apiErrorsEn> = {
  apiErrors: {
    // A latest-items widget's binding (#810).
    items_image_dimension_invalid: "Wähle ein Feld, das als Bild markiert ist.",
    items_time_dimension_invalid: "Wähle ein Datums- oder Zeitfeld.",
    items_dimension_unknown: "Dieses Feld gibt es im Modell nicht mehr.",
    state_dimension_unknown: "Dieses Feld gibt es im Modell nicht mehr.",
    state_name_dimension_invalid: "Wähle ein Textfeld für den Namen.",
    state_state_dimension_invalid:
      "Wähle ein Text- oder Ja/Nein-Feld für den Status.",
    state_changed_dimension_invalid: "Wähle ein Datums- oder Zeitfeld.",
    state_rolled_back_dimension_invalid: "Wähle ein Ja/Nein-Feld.",
    state_dimensions_not_distinct: "Wähle für jeden Teil ein anderes Feld.",
    store_mapping_duplicate:
      "Jede App darf nur zu einem verknüpften Produkt gehören.",
    store_scope_invalid:
      "Wähle eine App aus einer der ausgewählten Verbindungen.",
    store_website_invalid:
      "Wähle ein Projekt einer Vercel-Verbindung dieses Workspaces.",
    store_product_id_too_long:
      "Diese Produkt-ID ist zu lang für App-Identität-Einstellungen (höchstens 500 Zeichen). Kürze sie in den Produkt- und Zuordnungstabellen, um kostenpflichtig oder kostenlos und die Website festzulegen.",
    store_product_id_empty:
      "Dieses Produkt hat eine leere ID. Gib ihm in den Produkt- und Zuordnungstabellen eine ID, um kostenpflichtig oder kostenlos und die Website festzulegen.",
    store_product_unknown:
      "Diese App gehört nicht mehr zum Dashboard. Lade die Seite neu.",
    store_template_request_reused:
      "Diese Einrichtung wurde bereits gesendet. Öffne deine Dashboards oder starte eine neue Einrichtung.",
    store_template_removed:
      "Dieses Dashboard wurde nach dem Erstellen entfernt. Starte eine neue Einrichtung, um ein weiteres zu erstellen.",
    store_connector_required:
      "Wähle Verbindungen zu App Store Connect oder Google Play.",
    store_source_schema_unavailable:
      "Diese Connector-Version stellt die für die Vorlage benötigten Datensätze nicht bereit.",
    store_template_baseline_unavailable:
      "Für dieses Dashboard sind keine Updates verfügbar: Es wurde eingerichtet, bevor Vorlagen Versionen hatten, und eine seiner Store-Verbindungen wurde seitdem gelöscht. Das Dashboard funktioniert weiter wie bisher.",
    store_template_update_available:
      "Die Vorlage hat ein Update für dieses Dashboard. Wende es zuerst an oder schließe es und ändere danach die Apps.",
    store_scope_unchanged:
      "Das sind die Apps, die das Dashboard schon nutzt; nichts ändert sich.",
    store_template_up_to_date:
      "Dieses Dashboard ist schon auf dem neuesten Stand.",
    developer_project_names_limit:
      "Die Projektzuordnung verknüpft die Ressourcen einer Verbindung mit mehr als 9.999 Projekten, mehr als das Portfolio benennen kann. Entferne Zuordnungen aus der Tabelle „Projektzuordnung der Ressourcen“ unter Daten & Kennzahlen.",
    developer_default_links_limit:
      "Eine Verbindung hat mehr als 9.999 ausgewählte Ressourcen in ihrem Projekt, mehr als das Portfolio standardmäßig zuordnen kann. Wähle in den Einstellungen der Verbindung weniger Ressourcen aus oder nimm die Verbindung aus dem Projekt.",
    store_template_not_found:
      "Diese Vorlagen-Einrichtung gibt es nicht mehr. Geh zurück zu deinen Dashboards.",
    store_template_update_not_found:
      "Dieses Update gibt es nicht mehr. Lade die Seite neu, um den Stand des Dashboards zu sehen.",
    store_update_decision_missing:
      "Triff für jeden Eintrag unter „Deine Entscheidung“ und „Zum Entfernen vorgeschlagen“ eine Wahl und wende es dann erneut an.",
    store_update_stale:
      "Das Update hat sich geändert, seit du es geladen hast. Lade die Prüfung neu, prüf deine Entscheidungen und wende es erneut an.",
    store_update_open:
      "Ein früheres Update dieses Dashboards hat noch Entwürfe zum Veröffentlichen. Lade die Seite neu, um sie zu sehen: Veröffentliche sie in den Dateneinstellungen oder brich das frühere Update ab und wende dann dieses an.",
    store_update_closed:
      "Dieses Update wurde abgebrochen oder ist abgeschlossen. Lade die Seite neu, um das aktuelle Update zu prüfen.",
    store_update_superseded:
      "Ein neueres Update hat dieses ersetzt. Lade die Seite neu und mach mit dem neueren Update weiter.",
    store_update_drafts_unpublished:
      "Veröffentliche zuerst die Datenentwürfe des Updates in den Dateneinstellungen und erstelle dann das aktualisierte Dashboard.",
    store_update_review_changed:
      "Dein Dashboard hat sich geändert, seit du das Update geprüft hast. Brich dieses Update ab und prüf es erneut.",
    store_update_copy_exists:
      "Das aktualisierte Dashboard gibt es schon. Öffne es im Studio oder lade die Seite neu.",
    store_update_copy_missing:
      "Das aktualisierte Dashboard wurde gelöscht. Erstelle es erneut und nutze es dann auf deinen Bildschirmen.",
    store_update_copy_in_use:
      "Das aktualisierte Dashboard läuft auf Bildschirmen und kann deshalb nicht neu erstellt werden. Wechsle zuerst zurück.",
    store_update_copy_edited:
      "Du hast die aktualisierte Kopie bearbeitet. Wenn du sie neu erstellst, gehen diese Änderungen verloren: Wähle „Meine Änderungen verwerfen“, um fortzufahren.",
    store_update_original_changed:
      "Dein Original wurde bearbeitet, nachdem die aktualisierte Kopie erstellt wurde. Erstelle die Kopie erneut, damit sie diese Änderungen enthält.",
    store_update_not_swapped:
      "Das aktualisierte Dashboard läuft nicht auf deinen Bildschirmen, es gibt also nichts zurückzuwechseln. Lade die Seite neu.",
    store_update_unmergeable:
      "Das Update lässt sich mit einigen deiner Änderungen nicht zusammenführen. Behalte für die genannten Einträge deine Version und versuch es dann erneut.",
    dashboard_archived:
      "Dieses Dashboard ist archiviert, solange seine aktualisierte Kopie auf deinen Bildschirmen läuft. Wechsle auf seiner Update-Seite zurück, um es wieder zu nutzen oder zu bearbeiten.",

    last_owner:
      "Der letzte Inhaber eines Workspaces kann weder herabgestuft noch entfernt werden.",
    workspace_busy:
      "Der Workspace ist gerade beschäftigt. Es wurde nichts gelöscht; versuche es gleich noch einmal.",
    workspace_last:
      "Das ist dein einziger Workspace, deshalb lässt er sich nicht löschen. Es wurde nichts gelöscht. Lege zuerst einen weiteren Workspace an.",
    workspace_name_mismatch:
      "Das ist nicht der Name dieses Workspaces. Es wurde nichts gelöscht.",
    membership_exists: "Diese Person ist schon Mitglied dieses Workspaces.",
    email_delivery_failed:
      "Die Einladungs-E-Mail konnte nicht gesendet werden. Versuch es später noch einmal.",
    invitation_not_found: "Dieser Einladungslink ist ungültig.",
    invitation_revoked:
      "Diese Einladung wurde zurückgezogen. Bitte um eine neue.",
    invitation_used: "Diese Einladung wurde schon verwendet.",
    invitation_expired: "Diese Einladung ist abgelaufen. Bitte um eine neue.",
    invitation_email_mismatch:
      "Diese Einladung gilt für eine andere E-Mail-Adresse.",
    workspace_already_exists:
      "Für diese Installation gibt es schon einen Workspace.",
    forbidden: "Deine Rolle erlaubt diese Aktion nicht.",
    unauthorized: "Deine Sitzung ist abgelaufen – melde dich erneut an.",
    project_not_found: "Dieses Projekt gibt es nicht mehr.",
    project_archived:
      "Dieses Projekt ist archiviert. Hol es zuerst aus dem Archiv.",
    record_not_found: "Dieser Eintrag existiert nicht mehr.",
    invalid_request: "Die Anfrage war ungültig – prüf deine Eingaben.",
    payload_too_large: "Die Anfrage war zu groß zum Senden.",
    version_conflict:
      "Jemand anderes hat dieses Dashboard inzwischen gespeichert. Lade neu, um die Änderungen zu sehen, und bearbeite es dann erneut.",
    studio_dashboard:
      "Dieses Dashboard enthält jetzt Folien oder Widgets, die der Kachel-Editor nicht beibehalten kann. Lade es neu, bevor du es bearbeitest.",
    dashboard_not_found: "Dieses Dashboard existiert nicht mehr.",
    theme_not_found: "Dieses Design existiert nicht mehr.",
    review_not_found: "Diese Bewertung gibt es nicht mehr.",
    connection_not_found: "Diese Verbindung gibt es nicht mehr.",
    resource_selection_empty:
      "Wähle mindestens ein Projekt oder alle Projekte aus. Eine leere Auswahl kann nicht gespeichert werden.",
    connection_host_fixed:
      "Der Host einer Verbindung lässt sich nicht ändern: Ihr gespeicherter Key geht nur an den Host, für den er eingegeben wurde. Leg für den anderen Host eine neue Verbindung an.",
    custom_api_definition_not_found: "Diese eigene API gibt es nicht mehr.",
    custom_api_definition_invalid:
      "Die Definition der eigenen API enthält Fehler. Korrigier die markierten Felder und speichere erneut.",
    custom_api_definition_stale:
      "Jemand hat eine neuere Version dieser eigenen API gespeichert. Lade sie neu, um die Änderungen zu sehen.",
    custom_api_definition_archived:
      "Diese eigene API ist archiviert und kann nicht geändert oder verbunden werden.",
    custom_api_definition_limit:
      "Dieser Workspace hat die Höchstzahl eigener APIs erreicht. Archiviere eine, die du nicht mehr brauchst.",
    custom_api_stream_limit:
      "Diese eigene API hat mehr Streams, als dieser Server erlaubt.",
    custom_api_requires_definition:
      "Verbindungen zu eigenen APIs entstehen aus einer Definition.",
    custom_api_environment_not_found:
      "Diese Umgebung gehört nicht zu dieser eigenen API.",
    custom_api_variables_invalid:
      "Füll alle Verbindungswerte aus, die diese eigene API braucht.",
    custom_api_credentials_invalid:
      "Gib die Zugangsdaten ein, die die Anmeldemethode dieser eigenen API braucht.",
    custom_api_environment_needs_credentials:
      "Zum Wechsel der Umgebung brauchst du die Zugangsdaten erneut.",
    custom_api_connection_limit:
      "Dieser Workspace hat die Höchstzahl an Verbindungen zu eigenen APIs erreicht.",
    custom_api_token_failed:
      "Der Token-Endpunkt hat kein Token geliefert. Prüf die Token-URL und versuch es erneut.",
    custom_api_draft_not_found:
      "Diese Testanmeldung ist abgelaufen. Gib die Anmeldung erneut ein.",
    custom_api_draft_limit:
      "Zu viele unfertige eigene APIs. Stell zuerst eine fertig oder schließe sie.",
    custom_api_variable_reserved:
      "Dieser Name ist für die Anmeldung reserviert. Benenne den geheimen Verbindungswert um.",
    custom_api_secret_unknown:
      "Diese Anmeldemethode verwendet eines der eingegebenen Geheimnisse nicht.",
    custom_api_credentials_host_changed:
      "Du hast geändert, wohin netrics deine Anmeldung sendet. Gib sie erneut ein.",
    custom_api_client_change_with_config:
      "Speichere zuerst den neuen OAuth-Client, dann die anderen Einstellungen.",
    custom_api_test_rate_limited:
      "Zu viele Testanfragen in diesem Workspace. Warte eine Minute und versuch es erneut.",
    custom_api_test_busy: "Eine Testanfrage läuft noch.",
    custom_api_secret_missing: "Gib zuerst die Anmeldung ein.",
    custom_api_auth_rejected:
      "Die API hat die Anmeldung abgelehnt. Prüfe den Schlüssel oder das Token.",
    custom_api_destination_blocked:
      "netrics kann diese Adresse nicht erreichen.",
    custom_api_timeout: "Die API hat zu lange für die Antwort gebraucht.",
    // Versionen, Aktualisierungen, Export und Import (#808).
    custom_api_version_unchanged:
      "Diese Version hat denselben Inhalt wie die aktuelle.",
    custom_api_version_not_found: "Diese Version gibt es nicht.",
    custom_api_update_stale:
      "Die Verbindung wurde inzwischen geändert. Sieh dir die Aktualisierung noch einmal an.",
    custom_api_update_blocked: "Kläre zuerst, was die Aktualisierung braucht.",
    custom_api_update_none: "Diese Verbindung nutzt schon die neueste Version.",
    custom_api_import_invalid:
      "Diese Datei ist keine gültige Definition einer eigenen API.",
    custom_api_import_read_only_unconfirmed:
      "Diese Definition sendet JSON-Bodys per POST. Bestätige, dass diese Anfragen nur Daten lesen.",
    custom_api_import_newer:
      "Diese Datei stammt aus einer neueren netrics-Version. Aktualisiere netrics zuerst.",
    custom_api_import_too_large: "Die Datei ist größer als 512 KB.",
    custom_api_records_not_array: "Das ist keine Liste von Einträgen.",
    custom_api_http_error:
      "Die API hat mit einem Fehler geantwortet. Prüf den Anfragepfad und die Werte.",
    custom_api_graphql_errors:
      "Die GraphQL-API hat mit Fehlern geantwortet. Prüf die Abfrage und ihre Variablen.",
    custom_api_read_only_unconfirmed:
      "Bestätige vor dem Test, dass diese Anfrage nur Daten liest.",
    custom_api_response_invalid:
      "Die Antwort der API ließ sich nicht lesen. Prüf die Basis-URL und den Anfragepfad.",
    custom_api_request_invalid:
      "Die Anfrage ließ sich nicht erstellen. Prüf den Pfad, die Werte und die Header.",
    custom_api_test_failed:
      "Die Testanfrage ist fehlgeschlagen. Prüf die Basis-URL und versuch es erneut.",
    retention_dataset_unknown:
      "Diese Verbindung hat keine solche Datentabelle. Lade die Seite neu und wähle erneut.",
    reviews_not_supported:
      "Diese Verbindung hat keine Bewertungen. Ein Widget für die neueste Bewertung braucht eine App-Store-Connect-Verbindung.",
    goal_not_found: "Dieses Ziel existiert nicht mehr.",
    goal_name_taken:
      "In diesem Workspace gibt es schon ein Ziel mit diesem Namen.",
    period_not_supported:
      "Ein Ziel braucht einen Zeitraum mit Ende: heute, diese Woche, diesen Monat, dieses Quartal oder dieses Jahr.",
    goal_direction_unsupported:
      "Ein Ziel kann keiner Metrik folgen, bei der weniger besser ist, etwa der durchschnittlichen Position.",
    theme_name_taken:
      "In diesem Workspace gibt es schon ein Design mit diesem Namen.",
    contrast_too_low:
      "Manche Texte wären auf einem TV schwer zu lesen: Jede Textfarbe braucht mindestens 3:1 Kontrast zu ihrem Hintergrund.",
    theme_in_use:
      "Dashboards verwenden dieses Design noch. Wähl zuerst ein anderes Design für sie.",
    theme_in_use_by:
      "Diese Dashboards verwenden das Design noch: {names}. Wähl zuerst ein anderes Design für sie.",
    format_has_overflow:
      "Dieses Format kann noch nicht das primäre werden: Eine Folie geht dort auf mehr als einer Seite weiter. Ordne jede Folie in diesem Format auf einer Seite an (pass es an oder verschieb Widgets auf eine andere Folie) und versuch es dann noch mal.",
    format_has_hidden_widgets:
      "Dieses Format kann noch nicht das primäre werden: Eine Folie blendet dort Widgets aus. Zeig sie in diesem Format wieder an und versuch es dann noch mal.",
    tiles_primary_format:
      "Kachel-Dashboards werden immer für TV (16:9) angeordnet.",
    layout_invalid_page_count:
      "Ein angepasstes Layout muss zwischen einer und acht Seiten haben.",
    layout_page_out_of_range:
      "Ein Widget in einem angepassten Layout liegt auf einer Seite, die es nicht gibt.",
    layout_widget_out_of_bounds:
      "Ein Widget in einem angepassten Layout liegt außerhalb des Rasters dieses Formats.",
    layout_widget_too_small:
      "Ein Widget in einem angepassten Layout ist kleiner, als sein Typ erlaubt.",
    layout_widgets_overlap:
      "Zwei Widgets überlappen sich in einem angepassten Layout.",
    layout_widget_duplicated:
      "Ein Widget kommt in einem angepassten Layout doppelt vor.",
    layout_primary_format:
      "Das primäre Format kann kein angepasstes Layout haben. Lade das Dashboard neu.",
    layout_duplicate_format:
      "Eine Folie hat zwei angepasste Layouts für dasselbe Format. Lade das Dashboard neu.",
    widget_out_of_bounds:
      "Ein Widget liegt außerhalb des Rasters seiner Folie.",
    widget_too_small: "Ein Widget ist kleiner, als sein Typ erlaubt.",
    widgets_overlap: "Zwei Widgets auf einer Folie überlappen sich.",
    too_many_data_widgets:
      "Ein Dashboard zeigt höchstens 48 Widgets mit Daten. Entferne einige und versuch es dann erneut.",
    unknown_resource:
      "Ein Widget zeigt eine App oder ein Projekt, das seine Verbindung nicht mehr hat.",
    image_not_found:
      "Ein Bild, das dieses Dashboard verwendet, existiert nicht mehr.",
    image_in_use: "Dashboards verwenden dieses Bild noch.",
    image_in_use_by:
      "Diese Dashboards verwenden das Bild noch: {names}. Entferne es zuerst dort.",
    image_too_large:
      "Das Bild ist größer als 1 MiB. Exportiere es kleiner und versuch es noch einmal.",
    image_dimensions_too_large:
      "Das Bild ist zu groß: höchstens 4096 Pixel pro Seite.",
    image_animated:
      "Animierte Bilder werden nicht unterstützt. Verwende ein unbewegtes PNG, JPEG oder WebP.",
    image_invalid: "Diese Datei ist kein PNG-, JPEG- oder WebP-Bild.",
    image_quota_exceeded:
      "In diesem Workspace ist kein Platz für weitere Bilder. Lösch zuerst einige.",
    resource_icon_not_found:
      "Der App Store führt diese App (noch) nicht, daher gibt es kein Icon. Lade stattdessen eins hoch.",
    resource_icon_unavailable:
      "Das App-Icon konnte gerade nicht geladen werden. Versuch es später noch einmal oder lade eins hoch.",
    resource_icons_unsupported:
      "Diese Verbindung bietet keine Icons an. Lade stattdessen ein Bild hoch.",
    resource_not_found:
      "Diese App bzw. dieses Projekt gehört nicht mehr zu seiner Verbindung.",
    none_connected:
      "Verbinde zuerst eine Quelle: Die Übersicht zeigt die Zahlen deiner Verbindungen.",
    template_unsupported:
      "Für diese Verbindung gibt es noch keine Brand-Vorlage.",
    device_not_found: "Dieser TV existiert nicht mehr.",
    slide_scope_filter_unknown:
      "Der Bereich einer Folie nennt einen Filter, den dieses Dashboard nicht (mehr) hat.",
    slide_scope_value_invalid:
      "Der Bereich einer Folie braucht mindestens einen Wert oder einen Zeitraum mit Anfang oder Ende im Typ des Filters.",
    slide_scope_resource_conflict:
      "Ein Widget zeigt eine andere App als die, um die es auf seiner Folie geht. Zeig darin alle Apps oder schalte den Filter dafür aus.",
    device_scope_filter_unknown:
      "Der Bereich nennt einen Filter, den dieses Dashboard nicht (mehr) hat.",
    device_scope_value_invalid:
      "Wähl mindestens einen Wert oder einen Zeitraum mit Anfang oder Ende im Typ des Filters.",
    device_scope_not_applicable:
      "Dieses Dashboard hat Widgets, die dem Bereich nicht folgen können: ältere Widgets oder Widgets, die diesen Filter ignorieren. Ändere sie zuerst im Studio.",
    device_scope_dashboard_required:
      "Ein fester Bereich braucht ein Dashboard: Wähl zuerst eines.",
    device_scope_dashboard_changed:
      "Dieser Bildschirm hat einen festen Bereich für sein Dashboard. Entferne den Bereich oder leg einen neuen fest, um das Dashboard zu wechseln.",
    pairing_not_found:
      "Dieser Code ist ungültig. Prüf den Code auf dem TV; Codes laufen nach 10 Minuten ab, der TV zeigt dann vielleicht einen neuen.",
    too_many_attempts:
      "Zu viele falsche Codes. Warte 15 Minuten und versuch es dann noch einmal.",
    metric_not_found:
      "Die Metrik einer Kachel ist bei ihrer Verbindung nicht mehr verfügbar.",
    aggregation_not_supported: "Diese Aggregation passt nicht zur Metrik.",
    currency_required:
      "Wähl eine Währung für diesen Betrag: Beträge in verschiedenen Währungen werden nicht addiert.",
    metric_not_per_currency:
      "Diese Metrik ist kein Betrag in mehreren Währungen.",
    dashboard_model_deleted:
      "Ein Widget nutzt ein Modell, das inzwischen gelöscht wurde. Entferne das Widget oder verknüpfe es mit einem anderen Modell und speichere dann erneut.",
    compare_measure_model_not_found:
      "Ein Vergleichs-Widget nutzt ein Modell, das es in diesem Workspace nicht gibt. Nutze wieder seine Metriken.",
    compare_measure_not_found:
      "Ein Vergleichs-Widget nutzt eine Kennzahl, die sein Modell nicht hat. Nutze wieder seine Metriken oder veröffentliche die Kennzahl.",
    compare_units_incompatible:
      "Aus diesen beiden Metriken lässt sich dieses Verhältnis nicht bilden: Eine Währung wird nur durch dieselbe Währung geteilt, und Prozent braucht zwei Seiten ohne Währung.",
    currency_choice_conflict:
      "Eine Kachel zeigt entweder genau eine Währung oder rechnet in eine Anzeigewährung um, nicht beides.",
    currency_not_covered:
      "Die EZB veröffentlicht für diese Währung keinen Referenzkurs. Wähl EUR oder eine andere aufgeführte Währung.",
    currency_conversion_off:
      "Diese Instanz ruft keine Wechselkurse ab, daher bleiben Beträge pro Währung.",
    unknown_dimension:
      "Eine Kachel filtert nach einer Dimension, die die Metrik nicht hat.",
    oauth_reauthorization_required:
      "Die Autorisierung beim Anbieter funktioniert nicht mehr. Verbinde sie auf der Seite der Verbindung neu.",
    backfill_not_supported:
      "Dieser Connector kann seinen Verlauf nicht noch einmal lesen.",
    backfill_in_progress:
      "Der Verlauf wird bereits geladen. Warte, bis das fertig ist.",
    workspace_backfill_in_progress:
      "Eine andere Verbindung dieses Workspaces lädt gerade ihren Verlauf. Versuch es noch einmal, wenn das fertig ist.",
    history_reload_rate_limited:
      "Der Verlauf dieser Verbindung wurde vor Kurzem neu geladen. Versuch es später noch einmal.",
    connection_setup_pending:
      "Schließ zuerst die Einrichtung dieser Verbindung ab.",
    connector_unavailable:
      "Dieser Connector ist auf dieser Instanz nicht verfügbar.",
    connection_busy:
      "Die Verbindung wird gerade geändert. Versuch es gleich noch einmal.",
    analytics_unsupported:
      "App-Store-Analysen gibt es nur für App-Store-Connect-Verbindungen mit hochgeladenem Schlüssel.",
    app_store_analytics_admin_required:
      "Mit diesem Schlüssel lassen sich keine App-Store-Analysen anfordern: Das kann nur ein Teamschlüssel mit der Rolle Admin, einmalig. Verwende einen temporären Admin-Schlüssel und widerrufe ihn danach.",
    app_store_analytics_sales_key:
      "Das ist der Sales-Schlüssel, den netrics schon speichert. Er liest die Analyseberichte, kann sie aber nicht anfordern: Das kann nur ein Teamschlüssel mit der Rolle Admin, einmalig. Verwende einen temporären Admin-Schlüssel und widerrufe ihn danach.",
    app_store_analytics_reviews_key:
      "Das ist der Customer-Support-Schlüssel, den netrics schon für Bewertungen und Rezensionen speichert. Mit ihm lassen sich keine App-Store-Analysen anfordern: Das kann nur ein Teamschlüssel mit der Rolle Admin, einmalig. Verwende einen temporären Admin-Schlüssel und widerrufe ihn danach.",
    requestFailed: "Anfrage fehlgeschlagen ({code}).",
    invalidInput: "Prüf deine Eingaben – ein Feld fehlt oder ist ungültig.",
    generic: "Etwas ist schiefgelaufen.",
  },
};
