import type { Catalog } from "@netrics/domain";

import type { apiErrorsEn } from "./en";

export const apiErrorsDe: Catalog<typeof apiErrorsEn> = {
  apiErrors: {
    last_owner:
      "Der letzte Inhaber eines Workspaces kann weder herabgestuft noch entfernt werden.",
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
    record_not_found: "Dieser Eintrag existiert nicht mehr.",
    invalid_request: "Die Anfrage war ungültig – prüf deine Eingaben.",
    payload_too_large: "Die Anfrage war zu groß zum Senden.",
    version_conflict:
      "Jemand anderes hat dieses Dashboard inzwischen gespeichert. Lade neu, um die Änderungen zu sehen, und bearbeite es dann erneut.",
    studio_dashboard:
      "Dieses Dashboard enthält jetzt Folien oder Widgets, die der Kachel-Editor nicht beibehalten kann. Lade es neu, bevor du es bearbeitest.",
    dashboard_not_found: "Dieses Dashboard existiert nicht mehr.",
    theme_not_found: "Dieses Design existiert nicht mehr.",
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
      "Ein Dashboard zeigt höchstens 48 Widgets mit Daten.",
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
    connection_setup_pending:
      "Schließ zuerst die Einrichtung dieser Verbindung ab.",
    connector_unavailable:
      "Dieser Connector ist auf dieser Instanz nicht verfügbar.",
    connection_busy:
      "Die Verbindung wird gerade geändert. Versuch es gleich noch einmal.",
    analytics_unsupported:
      "App-Store-Analysen gibt es nur für App-Store-Connect-Verbindungen mit hochgeladenem Schlüssel.",
    requestFailed: "Anfrage fehlgeschlagen ({code}).",
    invalidInput: "Prüf deine Eingaben – ein Feld fehlt oder ist ungültig.",
    generic: "Etwas ist schiefgelaufen.",
  },
};
