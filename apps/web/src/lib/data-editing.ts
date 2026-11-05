import {
  DataProcessingError,
  type PreparationGraph,
  type PreparationNode,
  type DataField,
  type DataType,
} from "@netrics/domain";
import { ApiError } from "./api";
import { ZodError } from "zod";

export const newDataId = () =>
  "f_" + crypto.randomUUID().replaceAll("-", "").slice(0, 16);
/** Keep only ancestors when previewing a step, so later draft errors cannot hide it. */
export function preparationAt(
  graph: PreparationGraph,
  output: string,
): PreparationGraph {
  const required = new Set<string>();
  const visit = (id: string) => {
    if (required.has(id)) return;
    required.add(id);
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) return;
    if ("input" in node) visit(node.input);
    if (node.type === "join") {
      visit(node.left);
      visit(node.right);
    }
    if (node.type === "append") node.inputs.forEach(visit);
  };
  visit(output);
  return {
    version: 1,
    nodes: graph.nodes.filter((n) => required.has(n.id)),
    outputs: [output],
  };
}
export function appendPreparation(
  graph: PreparationGraph,
  nodes: PreparationNode[],
  output: string,
) {
  return {
    ...graph,
    nodes: [...graph.nodes, ...nodes],
    outputs: graph.outputs.map((id) => (id === output ? nodes.at(-1)!.id : id)),
  };
}
export function dataErrorKey(error: unknown) {
  if (error instanceof ZodError) return "invalid";
  const code =
    error instanceof ApiError || error instanceof DataProcessingError
      ? error.code
      : "";
  if (code === "version_conflict") return "conflict";
  if (/cardinality|not_unique|identity_conflict/.test(code))
    return "cardinality";
  if (/quota|limit|budget|capacity/.test(code)) return "limit";
  if (/expired|replay_unavailable/.test(code)) return "expired";
  if (/not_published|source_pending/.test(code)) return "unpublished";
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
export function enteredValue(
  type: DataType,
  text: string,
  nullable: boolean,
): unknown {
  if (text === "" && nullable) return null;
  if (type === "integer" || type === "number") {
    if (!text.trim()) throw new DataProcessingError("data_number_invalid");
    const number = Number(text);
    if (
      !Number.isFinite(number) ||
      (type === "integer" && !Number.isSafeInteger(number))
    )
      throw new DataProcessingError("data_number_invalid");
    return number;
  }
  if (type === "boolean") {
    if (/^true$/i.test(text)) return true;
    if (/^false$/i.test(text)) return false;
    throw new DataProcessingError("data_boolean_invalid");
  }
  if (type === "json") {
    try {
      return JSON.parse(text);
    } catch {
      throw new DataProcessingError("data_json_invalid");
    }
  }
  return text;
}
/** CSV/TSV parser preserving text and exact decimal representations. */
export function parseEnteredTable(text: string): {
  fields: DataField[];
  rows: string[][];
} {
  const input = text.replace(/^\uFEFF/, "");
  const firstLine = input.split(/\r?\n/, 1)[0] ?? "";
  let inHeaderQuote = false;
  const separators: Record<string, number> = { "\t": 0, ",": 0, ";": 0 };
  for (let i = 0; i < firstLine.length; i++) {
    const char = firstLine[i]!;
    if (char === '"') {
      if (inHeaderQuote && firstLine[i + 1] === '"') i++;
      else inHeaderQuote = !inHeaderQuote;
    } else if (!inHeaderQuote && Object.hasOwn(separators, char))
      separators[char]!++;
  }
  const separator = Object.keys(separators).sort(
    (a, b) => separators[b]! - separators[a]!,
  )[0]!;
  const records: string[][] = [];
  let row: string[] = [],
    value = "",
    quoted = false,
    closedQuote = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (char === '"') {
      if (quoted && input[i + 1] === '"') {
        value += '"';
        i++;
      } else if (quoted) {
        quoted = false;
        closedQuote = true;
      } else if (!value.length && !closedQuote) quoted = true;
      else throw new DataProcessingError("table_invalid");
    } else if (!quoted && char === separator) {
      row.push(value);
      value = "";
      closedQuote = false;
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && input[i + 1] === "\n") i++;
      row.push(value);
      if (row.some((v) => v !== "")) records.push(row);
      row = [];
      value = "";
      closedQuote = false;
    } else {
      if (closedQuote) throw new DataProcessingError("table_invalid");
      value += char;
    }
  }
  if (quoted) throw new DataProcessingError("table_invalid");
  row.push(value);
  if (row.some((v) => v !== "")) records.push(row);
  const [headers, ...rows] = records;
  if (
    !headers?.length ||
    !rows.length ||
    headers.some((h) => !h.trim() || h.length > 100) ||
    new Set(headers.map((name) => name.trim().toLowerCase())).size !==
      headers.length ||
    rows.some((r) => r.length !== headers.length)
  )
    throw new DataProcessingError("table_invalid");
  return {
    fields: headers.map((name, index) => ({
      id: "column_" + index,
      name: name.trim(),
      type: "string",
      nullable: index !== 0,
    })),
    rows,
  };
}
