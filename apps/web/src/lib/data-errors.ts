export function dataErrorCodeKey(code: string) {
  if (/measure_scope_required|measure_grain_invalid/.test(code)) return "scope";
  if (/dimension_label/.test(code)) return "label";
  if (code === "version_conflict") return "conflict";
  if (/cardinality|not_unique|identity_conflict/.test(code))
    return "cardinality";
  if (/quota|limit|budget|capacity/.test(code)) return "limit";
  if (code === "data_source_pending") return "pending";
  if (/expired|replay_unavailable|history_unavailable/.test(code))
    return "expired";
  if (/not_published/.test(code)) return "unpublished";
  if (/cycle|ambiguous_path/.test(code)) return "cycle";
  if (/incompatible_dimension|relationship_path|filter/.test(code))
    return "filter";
  if (/unit|currency|numeric|type_mismatch|explicit.*cast/.test(code))
    return "units";
  if (/field.*(missing|not_found)|schema_changed/.test(code)) return "field";
  if (/formula|expression/.test(code)) return "formula";
  if (/invalid|exists|snapshot_required|key_taken/.test(code)) return "invalid";
  return "generic";
}
