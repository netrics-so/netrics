/**
 * Messages for the API's error codes (ADR 0016 section 5: the API returns
 * codes, the web app words them). Keys are the codes; `apiErrorMessage`
 * in lib/api.ts picks them.
 */
export const apiErrorsEn = {
  apiErrors: {
    // A latest-items widget's binding (#810).
    items_image_dimension_invalid: "Pick a field marked as image.",
    items_time_dimension_invalid: "Pick a date or time field.",
    items_dimension_unknown: "This field is no longer in the model.",
    store_mapping_duplicate: "Each app can belong to only one linked product.",
    store_scope_invalid: "Choose an app from one of the selected connections.",
    store_website_invalid:
      "Choose a project of a Vercel connection of this workspace.",
    store_product_id_too_long:
      "This product ID is too long for app identity settings (at most 500 characters). Shorten it in the Products and mapping tables to set paid or free and the website.",
    store_product_id_empty:
      "This product has an empty ID. Give it an ID in the Products and mapping tables to set paid or free and the website.",
    store_product_unknown:
      "This app no longer belongs to the dashboard. Reload the page.",
    store_template_request_reused:
      "This setup was already submitted. Open your dashboards or start a new setup.",
    store_template_removed:
      "This dashboard was removed after creation. Start a new setup to create another.",
    store_connector_required:
      "Choose App Store Connect or Google Play connections.",
    store_source_schema_unavailable:
      "This connector version does not provide the datasets this template needs.",
    store_template_baseline_unavailable:
      "Updates aren’t available for this dashboard: it was set up before templates had versions, and a store connection it used was deleted since. The dashboard keeps working as it is.",
    store_template_up_to_date: "This dashboard is already up to date.",
    store_template_update_available:
      "The template has an update for this dashboard. Apply or close it first, then change the apps.",
    store_scope_unchanged:
      "These are the apps the dashboard already uses; nothing changes.",
    store_template_not_found:
      "This template setup no longer exists. Go back to your dashboards.",
    store_template_update_not_found:
      "This update no longer exists. Reload the page to see where the dashboard stands.",
    store_update_decision_missing:
      "Make a choice for every item under “Your choice” and “Proposed for removal”, then apply again.",
    store_update_stale:
      "The update changed since you loaded it. Reload the review, check your choices and apply again.",
    store_update_open:
      "An earlier update of this dashboard still has drafts to publish. Reload the page to see them: publish them in data settings, or stop that update, then apply this one.",
    store_update_closed:
      "This update was stopped or has finished. Reload the page to review the current update.",
    store_update_superseded:
      "A newer update replaced this one. Reload the page and continue with the newer update.",
    store_update_drafts_unpublished:
      "Publish the update’s data drafts in data settings first, then create the updated dashboard.",
    store_update_review_changed:
      "Your dashboard changed since you reviewed the update. Stop this update and review it again.",
    store_update_copy_exists:
      "The updated dashboard already exists. Open it in Studio, or reload the page.",
    store_update_copy_missing:
      "The updated dashboard was deleted. Create it again, then use it on your screens.",
    store_update_copy_in_use:
      "The updated dashboard is on screens, so it can’t be made again. Switch back first.",
    store_update_copy_edited:
      "You edited the updated copy. Creating it again discards those edits: choose “Discard my edits” to go ahead.",
    store_update_original_changed:
      "Your original dashboard was edited after the updated copy was made. Create the copy again so it includes those edits.",
    store_update_not_swapped:
      "The updated dashboard isn’t on your screens, so there is nothing to switch back. Reload the page.",
    store_update_unmergeable:
      "The update can’t be combined with some of your changes. Keep your version of the named items, then try again.",
    dashboard_archived:
      "This dashboard is archived while its updated copy is on your screens. Switch back on its update page to use or edit it again.",

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
    project_not_found: "This project no longer exists.",
    project_archived: "This project is archived. Unarchive it first.",
    record_not_found: "That record no longer exists.",
    invalid_request: "The request was invalid — check your input.",
    payload_too_large: "The request was too large to send.",
    version_conflict:
      "Someone else saved this dashboard in the meantime. Reload to see their changes, then edit again.",
    studio_dashboard:
      "This dashboard now has slides or widgets that the tile editor cannot keep. Reload it before editing.",
    dashboard_not_found: "This dashboard no longer exists.",
    theme_not_found: "That theme no longer exists.",
    goal_not_found: "That goal no longer exists.",
    review_not_found: "That review no longer exists.",
    connection_not_found: "That connection no longer exists.",
    custom_api_definition_not_found: "That custom API no longer exists.",
    custom_api_definition_invalid:
      "The custom API definition has errors. Fix the marked fields and save again.",
    custom_api_definition_stale:
      "Someone saved a newer version of this custom API. Reload it to see the changes.",
    custom_api_definition_archived:
      "This custom API is archived and can't be changed or connected.",
    custom_api_definition_limit:
      "This workspace has reached its limit of custom APIs. Archive one you no longer need.",
    custom_api_stream_limit:
      "This custom API has more streams than this server allows.",
    custom_api_requires_definition:
      "Custom API connections are created from a custom API definition.",
    custom_api_environment_not_found:
      "That environment is not part of this custom API.",
    custom_api_variables_invalid:
      "Fill in every connection value this custom API needs.",
    custom_api_credentials_invalid:
      "Enter the credentials this custom API's login method needs.",
    custom_api_environment_needs_credentials:
      "Changing the environment needs the credentials again.",
    custom_api_connection_limit:
      "This workspace has reached its limit of custom API connections.",
    custom_api_token_failed:
      "The token endpoint did not answer with a token. Check the token URL and try again.",
    custom_api_draft_not_found:
      "This test login expired. Enter the login again.",
    custom_api_draft_limit:
      "Too many unfinished custom APIs. Finish or close one first.",
    custom_api_variable_reserved:
      "This name is reserved for the login. Rename the secret connection value.",
    custom_api_secret_unknown:
      "This login method does not use one of the entered secrets.",
    custom_api_credentials_host_changed:
      "You changed where netrics sends your login. Enter it again.",
    custom_api_test_rate_limited:
      "Too many test requests in this workspace. Wait a minute and try again.",
    custom_api_test_busy: "A test request is still running.",
    custom_api_secret_missing: "Enter the login first.",
    custom_api_auth_rejected:
      "The API refused the login. Check the key or token.",
    custom_api_destination_blocked: "netrics can't reach this address.",
    custom_api_timeout: "The API took too long to answer.",
    // Versions, connection updates, export and import (#808).
    custom_api_version_unchanged:
      "This version has the same content as the current one.",
    custom_api_version_not_found: "This version doesn't exist.",
    custom_api_update_stale:
      "The connection changed meanwhile. Review the update again.",
    custom_api_update_blocked: "Resolve what the update needs first.",
    custom_api_update_none: "This connection already uses the newest version.",
    custom_api_import_invalid:
      "This file is not a valid custom API definition.",
    custom_api_import_newer:
      "This file is from a newer netrics. Update netrics first.",
    custom_api_import_too_large: "The file is larger than 512 KB.",
    custom_api_records_not_array: "This is not a list of records.",
    custom_api_http_error:
      "The API answered with an error. Check the request path and the values.",
    custom_api_response_invalid:
      "The API answer could not be read. Check the base URL and the request path.",
    custom_api_request_invalid:
      "The request could not be built. Check the path, the values and the headers.",
    custom_api_test_failed:
      "The test request failed. Check the base URL and try again.",
    retention_dataset_unknown:
      "This connection has no such data table. Reload the page and choose again.",
    reviews_not_supported:
      "This connection has no reviews. A latest-review widget needs an App Store Connect connection.",
    goal_name_taken: "A goal with that name already exists in this workspace.",
    period_not_supported:
      "A goal needs a period with an end: today, this week, month, quarter or year.",
    goal_direction_unsupported:
      "A goal cannot follow a metric where lower is better, such as average position.",
    theme_name_taken:
      "A theme with that name already exists in this workspace.",
    contrast_too_low:
      "Some text would be too hard to read on a TV: every text colour needs at least 3:1 contrast against its background.",
    theme_in_use:
      "Dashboards still use this theme. Pick another theme for them first.",
    theme_in_use_by:
      "Dashboards still use this theme: {names}. Pick another theme for them first.",
    widget_out_of_bounds: "A widget lies outside its slide's grid.",
    format_has_overflow:
      "That format cannot become the primary yet: a slide continues on more than one page there. Arrange every slide to fit one page in that format (customise it, or move widgets to another slide), then try again.",
    format_has_hidden_widgets:
      "That format cannot become the primary yet: a slide hides widgets there. Show them in that format, then try again.",
    tiles_primary_format: "Tile dashboards are always laid out for TV (16:9).",
    layout_invalid_page_count:
      "A custom layout must have between one and eight pages.",
    layout_page_out_of_range:
      "A widget in a custom layout is on a page that does not exist.",
    layout_widget_out_of_bounds:
      "A widget in a custom layout lies outside that format's grid.",
    layout_widget_too_small:
      "A widget in a custom layout is smaller than its type allows.",
    layout_widgets_overlap: "Two widgets overlap in a custom layout.",
    layout_widget_duplicated: "A widget appears twice in a custom layout.",
    layout_primary_format:
      "The primary format cannot have a custom layout. Reload the dashboard.",
    layout_duplicate_format:
      "A slide has two custom layouts for the same format. Reload the dashboard.",
    widget_too_small: "A widget is smaller than its type allows.",
    widgets_overlap: "Two widgets on a slide overlap.",
    too_many_data_widgets:
      "A dashboard shows at most 48 data widgets. Remove some, then try again.",
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
    slide_scope_filter_unknown:
      "A slide's scope names a filter this dashboard does not have (any more).",
    slide_scope_value_invalid:
      "A slide's scope needs at least one value, or a range with a start or an end, of the filter’s type.",
    slide_scope_resource_conflict:
      "A widget shows another app than the one its slide is about. Show all apps in it, or turn the filter off for it.",
    device_scope_filter_unknown:
      "The scope names a filter this dashboard does not have (any more).",
    device_scope_value_invalid:
      "Choose at least one value, or a range with a start or an end, of the filter’s type.",
    device_scope_not_applicable:
      "This dashboard has widgets that cannot follow the scope: older widgets, or widgets that ignore this filter. Change them in the Studio first.",
    device_scope_dashboard_required:
      "A fixed scope needs a dashboard: choose one first.",
    device_scope_dashboard_changed:
      "This screen has a fixed scope for its dashboard. Remove the scope, or set a new one, to change the dashboard.",
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
    dashboard_model_deleted:
      "A widget uses a model that was deleted in the meantime. Remove the widget or bind it to another model, then save again.",
    compare_measure_model_not_found:
      "A compare widget uses a model this workspace doesn’t have. Use its metrics again.",
    compare_measure_not_found:
      "A compare widget uses a measure its model doesn’t have. Use its metrics again or publish the measure.",
    compare_units_incompatible:
      "These two metrics cannot form this ratio: a currency is divided only by the same currency, and a percentage needs two sides without currency.",
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
    backfill_not_supported: "This connector cannot read its history again.",
    backfill_in_progress:
      "The history is already loading. Wait until it has finished.",
    workspace_backfill_in_progress:
      "Another connection of this workspace is loading its history. Try again when it has finished.",
    history_reload_rate_limited:
      "The history of this connection was reloaded recently. Try again later.",
    connection_setup_pending: "Finish setting up this connection first.",
    connector_unavailable: "This connector is not available on this instance.",
    connection_busy:
      "The connection is changing right now. Try again in a moment.",
    analytics_unsupported:
      "App Store analytics are only available for App Store Connect connections with an uploaded key.",
    app_store_analytics_admin_required:
      "This key cannot request App Store analytics: only a team key with the Admin role can, once. Use a temporary Admin key and revoke it afterwards.",
    app_store_analytics_sales_key:
      "This is the Sales key netrics already stores. It reads the analytics reports but cannot request them: only a team key with the Admin role can, once. Use a temporary Admin key and revoke it afterwards.",
    app_store_analytics_reviews_key:
      "This is the Customer Support key netrics already stores for ratings and reviews. It cannot request App Store analytics: only a team key with the Admin role can, once. Use a temporary Admin key and revoke it afterwards.",
    requestFailed: "Request failed ({code}).",
    invalidInput: "Check your input — a field is missing or invalid.",
    generic: "Something went wrong.",
  },
} as const;
