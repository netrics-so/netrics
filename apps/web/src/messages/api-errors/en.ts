/**
 * Messages for the API's error codes (ADR 0016 section 5: the API returns
 * codes, the web app words them). Keys are the codes; `apiErrorMessage`
 * in lib/api.ts picks them.
 */
export const apiErrorsEn = {
  apiErrors: {
    last_owner: "The last owner of a workspace cannot be demoted or removed.",
    membership_exists: "That person is already a member of this workspace.",
    email_delivery_failed:
      "The invitation email could not be sent. Try again later.",
    invitation_not_found: "This invitation link is not valid.",
    invitation_revoked: "This invitation was withdrawn. Ask for a new one.",
    invitation_used: "This invitation has already been used.",
    invitation_expired: "This invitation has expired. Ask for a new one.",
    invitation_email_mismatch:
      "This invitation is for a different email address.",
    workspace_already_exists:
      "A workspace already exists for this installation.",
    forbidden: "Your role does not allow this action.",
    unauthorized: "Your session has expired — sign in again.",
    record_not_found: "That record no longer exists.",
    invalid_request: "The request was invalid — check your input.",
    payload_too_large: "The request was too large to send.",
    version_conflict:
      "Someone else saved this dashboard in the meantime. Reload to see their changes, then edit again.",
    studio_dashboard:
      "This dashboard now has slides or widgets that the tile editor cannot keep. Reload it before editing.",
    dashboard_not_found: "This dashboard no longer exists.",
    theme_not_found: "That theme no longer exists.",
    theme_name_taken:
      "A theme with that name already exists in this workspace.",
    contrast_too_low:
      "Some text would be too hard to read on a TV: every text colour needs at least 3:1 contrast against its background.",
    theme_in_use:
      "Dashboards still use this theme. Pick another theme for them first.",
    theme_in_use_by:
      "Dashboards still use this theme: {names}. Pick another theme for them first.",
    widget_out_of_bounds: "A widget lies outside its slide's grid.",
    widget_too_small: "A widget is smaller than its type allows.",
    widgets_overlap: "Two widgets on a slide overlap.",
    too_many_data_widgets: "A dashboard shows at most 48 data widgets.",
    unknown_resource:
      "A widget shows an app or project its connection no longer has.",
    image_not_found: "An image this dashboard uses no longer exists.",
    image_in_use: "Dashboards still use this image.",
    image_in_use_by:
      "Dashboards still use this image: {names}. Remove it from them first.",
    image_too_large:
      "That image is larger than 1 MiB. Export it smaller and try again.",
    image_dimensions_too_large:
      "That image is too large: at most 4096 pixels per side.",
    image_animated:
      "Animated images are not supported. Use a still PNG, JPEG or WebP.",
    image_invalid: "That file is not a PNG, JPEG or WebP image.",
    image_quota_exceeded:
      "This workspace has no room for more images. Delete some first.",
    resource_icon_not_found:
      "The App Store does not list this app (yet), so it has no icon to use. Upload one instead.",
    resource_icon_unavailable:
      "The app icon could not be fetched right now. Try again later, or upload one.",
    resource_icons_unsupported:
      "This connection has no icons to offer. Upload an image instead.",
    resource_not_found:
      "That app or project is no longer part of its connection.",
    none_connected:
      "Connect a source first: the Overview shows the numbers of your connections.",
    template_unsupported: "There is no Brand template for this connection yet.",
    device_not_found: "That TV no longer exists.",
    pairing_not_found:
      "That code is not valid. Check the code on the TV; codes expire after 10 minutes, so the TV may show a new one.",
    too_many_attempts: "Too many wrong codes. Wait 15 minutes, then try again.",
    metric_not_found:
      "A tile's metric is no longer available from its connection.",
    aggregation_not_supported: "That aggregation does not fit the metric.",
    currency_required:
      "Pick a currency for this amount: amounts in different currencies are not added up.",
    metric_not_per_currency:
      "This metric is not an amount in several currencies.",
    currency_choice_conflict:
      "A tile shows one currency exactly or converts into a display currency, not both.",
    currency_not_covered:
      "The ECB publishes no reference rate for that currency. Pick EUR or another listed currency.",
    currency_conversion_off:
      "This instance does not fetch exchange rates, so amounts stay per currency.",
    unknown_dimension:
      "A tile filters on a dimension the metric does not have.",
    oauth_reauthorization_required:
      "The authorization at the provider stopped working. Reconnect it from the connection page.",
    connection_setup_pending: "Finish setting up this connection first.",
    connector_unavailable: "This connector is not available on this instance.",
    connection_busy:
      "The connection is changing right now. Try again in a moment.",
    analytics_unsupported:
      "App Store analytics are only available for App Store Connect connections with an uploaded key.",
    requestFailed: "Request failed ({code}).",
    invalidInput: "Check your input — a field is missing or invalid.",
    generic: "Something went wrong.",
  },
} as const;
