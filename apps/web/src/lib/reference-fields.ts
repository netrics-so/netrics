import {
  DataProcessingError,
  type DataField,
  type DataType,
} from "@netrics/domain";

export function referenceTypeConstraint(
  field: DataField,
  fields: DataField[],
): "currency" | "exact" | null {
  if (fields.some((candidate) => candidate.currencyField === field.id))
    return "currency";
  if (
    field.currencyField ||
    field.scale !== undefined ||
    ["currency", "currency_minor"].includes(field.unit ?? "")
  )
    return "exact";
  return null;
}
export function referenceTypeAllowed(
  field: DataField,
  fields: DataField[],
  type: DataType,
): boolean {
  const constraint = referenceTypeConstraint(field, fields);
  return constraint === "currency"
    ? type === "string"
    : constraint === "exact"
      ? ["decimal", "integer"].includes(type)
      : true;
}

/** Currency metadata is explicit; requiring its identity never changes source values. */
export function setReferenceCurrency(
  fields: DataField[],
  amountId: string,
  currencyId: string,
): DataField[] {
  const amount = fields.find((field) => field.id === amountId),
    currency = fields.find((field) => field.id === currencyId);
  if (
    !amount ||
    !["decimal", "integer"].includes(amount.type) ||
    (currencyId &&
      (!currency || currency.type !== "string" || currency.id === amountId))
  )
    throw new DataProcessingError("data_currency_invalid");
  return fields.map((field) =>
    field.id === amountId
      ? {
          ...field,
          currencyField: currencyId || undefined,
          unit: currencyId
            ? field.unit === "currency_minor"
              ? "currency_minor"
              : "currency"
            : ["currency", "currency_minor"].includes(field.unit ?? "")
              ? undefined
              : field.unit,
        }
      : field.id === currencyId
        ? { ...field, nullable: false }
        : field,
  );
}
