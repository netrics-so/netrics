import {
  DataProcessingError,
  type PreparationGraph,
  type PreparationNode,
} from "@netrics/domain";

export type PreparationEditProblem =
  | "missingStep"
  | "outputIdentity"
  | "sourceInUse"
  | "chooseInput"
  | "branchMove"
  | "noNeighbour"
  | "cycle"
  | "identityChanged"
  | "appendDuplicate";
export class PreparationEditError extends Error {
  constructor(public readonly problem: PreparationEditProblem) {
    super(problem);
  }
}
function fail(problem: PreparationEditProblem): never {
  throw new PreparationEditError(problem);
}
export function preparationStepInputs(node: PreparationNode): string[] {
  if (node.type === "source") return [];
  if (node.type === "append") return node.inputs;
  if (node.type === "join") return [node.left, node.right];
  return [node.input];
}
function rewire(
  node: PreparationNode,
  from: string,
  to: string,
): PreparationNode {
  if (node.type === "append") {
    // Appending one step to itself would duplicate its rows.
    if (node.inputs.includes(from) && node.inputs.includes(to))
      fail("appendDuplicate");
    return {
      ...node,
      inputs: node.inputs.map((id) => (id === from ? to : id)),
      ...(node.columnMappings
        ? {
            columnMappings: Object.fromEntries(
              Object.entries(node.columnMappings).map(([id, mapping]) => [
                id === from ? to : id,
                mapping,
              ]),
            ),
          }
        : {}),
    };
  }
  if (node.type === "join")
    return {
      ...node,
      left: node.left === from ? to : node.left,
      right: node.right === from ? to : node.right,
    };
  return "input" in node && node.input === from ? { ...node, input: to } : node;
}
function assertGraph(graph: PreparationGraph) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  if (nodes.size !== graph.nodes.length) fail("identityChanged");
  const done = new Set<string>(),
    visiting = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) fail("cycle");
    if (done.has(id)) return;
    const node = nodes.get(id);
    if (!node) fail("missingStep");
    visiting.add(id);
    preparationStepInputs(node).forEach(visit);
    visiting.delete(id);
    done.add(id);
  };
  graph.nodes.forEach((node) => visit(node.id));
  graph.outputs.forEach((id) => {
    if (!nodes.has(id)) fail("missingStep");
  });
}
/** Choices exclude the step and its descendants, so editing a merge cannot create a cycle. */
export function preparationInputNodes(
  graph: PreparationGraph,
  stepId: string,
): PreparationNode[] {
  const blocked = new Set([stepId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of graph.nodes)
      if (
        !blocked.has(node.id) &&
        preparationStepInputs(node).some((id) => blocked.has(id))
      ) {
        blocked.add(node.id);
        changed = true;
      }
  }
  return graph.nodes.filter((node) => !blocked.has(node.id));
}
/** Replace exactly one operation while retaining all branches and public identities. */
export function replacePreparationStep(
  graph: PreparationGraph,
  stepId: string,
  replacements: PreparationNode[],
): PreparationGraph {
  const original = graph.nodes.find((node) => node.id === stepId);
  if (!original) fail("missingStep");
  const replacement = replacements.find((node) => node.id === stepId);
  if (
    !replacement ||
    replacement.type !== original.type ||
    replacements.filter((node) => node.id === stepId).length !== 1
  )
    fail("identityChanged");
  if (
    original.type === "calculate" &&
    replacement.type === "calculate" &&
    original.fieldId !== replacement.fieldId
  )
    fail("identityChanged");
  if (
    original.type === "join" &&
    replacement.type === "join" &&
    original.rightPrefix !== replacement.rightPrefix
  )
    fail("identityChanged");
  const next = {
    ...graph,
    nodes: graph.nodes.flatMap((node) =>
      node.id === stepId ? replacements : [node],
    ),
  };
  assertGraph(next);
  return next;
}
export function removePreparationStep(
  graph: PreparationGraph,
  stepId: string,
  bypass?: string,
): PreparationGraph {
  const original = graph.nodes.find((node) => node.id === stepId);
  if (!original) fail("missingStep");
  if (graph.outputs.includes(stepId)) {
    if (!("input" in original) || graph.outputs.includes(original.input))
      fail("outputIdentity");
    const predecessor = graph.nodes.find((node) => node.id === original.input);
    if (!predecessor) fail("missingStep");
    const next: PreparationGraph = {
      ...graph,
      nodes: graph.nodes
        .filter((node) => node.id !== stepId)
        .map((node) => {
          const rewired = rewire(node, predecessor.id, stepId);
          return node.id === predecessor.id
            ? { ...rewired, id: stepId }
            : rewired;
        }),
    };
    assertGraph(next);
    return next;
  }
  const inputs = preparationStepInputs(original);
  const users = graph.nodes.filter((node) =>
    preparationStepInputs(node).includes(stepId),
  );
  if (original.type === "source" && users.length) fail("sourceInUse");
  const replacement = inputs.length === 1 ? inputs[0] : bypass;
  if (inputs.length > 1 && (!replacement || !inputs.includes(replacement)))
    fail("chooseInput");
  const next = {
    ...graph,
    nodes: graph.nodes
      .filter((node) => node.id !== stepId)
      .map((node) => (replacement ? rewire(node, stepId, replacement) : node)),
  };
  assertGraph(next);
  return next;
}
/** Swap adjacent unary operations by their dependencies, never by list order alone. */
export function movePreparationStep(
  graph: PreparationGraph,
  stepId: string,
  direction: "up" | "down",
): PreparationGraph {
  const selected = graph.nodes.find((node) => node.id === stepId);
  if (!selected) fail("missingStep");
  if (!("input" in selected)) fail("branchMove");
  const users = (id: string) =>
    graph.nodes.filter((node) => preparationStepInputs(node).includes(id));
  const before =
    direction === "up"
      ? graph.nodes.find((node) => node.id === selected.input)
      : selected;
  const after = direction === "up" ? selected : users(selected.id)[0];
  if (!before || !after) fail("noNeighbour");
  if (
    !("input" in before) ||
    !("input" in after) ||
    after.input !== before.id ||
    users(before.id).length !== 1
  )
    fail("branchMove");
  if (graph.outputs.includes(before.id) || graph.outputs.includes(after.id))
    fail("outputIdentity");
  const previous = before.input;
  const next: PreparationGraph = {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.id === before.id) return { ...before, input: after.id };
      if (node.id === after.id) return { ...after, input: previous };
      return rewire(node, after.id, before.id);
    }),
  };
  const beforeIndex = next.nodes.findIndex((node) => node.id === before.id),
    afterIndex = next.nodes.findIndex((node) => node.id === after.id);
  [next.nodes[beforeIndex], next.nodes[afterIndex]] = [
    next.nodes[afterIndex]!,
    next.nodes[beforeIndex]!,
  ];
  assertGraph(next);
  return next;
}
export function preparationMoveProblem(
  graph: PreparationGraph,
  stepId: string,
  direction: "up" | "down",
): PreparationEditProblem | null {
  try {
    movePreparationStep(graph, stepId, direction);
    return null;
  } catch (error) {
    if (error instanceof PreparationEditError) return error.problem;
    throw error;
  }
}
export function preparationRemovalProblem(
  graph: PreparationGraph,
  stepId: string,
): PreparationEditProblem | null {
  const step = graph.nodes.find((node) => node.id === stepId);
  try {
    removePreparationStep(
      graph,
      stepId,
      step ? preparationStepInputs(step)[0] : undefined,
    );
    return null;
  } catch (error) {
    if (error instanceof PreparationEditError) return error.problem;
    throw error;
  }
}

/** Suggestions are proposals only; the form must explicitly enable matching. */
export function suggestAppendColumnMapping(
  targets: readonly import("@netrics/domain").DataField[],
  source: readonly import("@netrics/domain").DataField[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const target of targets) {
    const exact = source.find(
      (field) => field.id === target.id && field.type === target.type,
    );
    const name = target.name.toLocaleLowerCase();
    const matches = source.filter(
      (field) =>
        field.type === target.type && field.name.toLocaleLowerCase() === name,
    );
    const targetNameIsUnique =
      targets.filter((field) => field.name.toLocaleLowerCase() === name)
        .length === 1;
    const candidate =
      exact ??
      (targetNameIsUnique && matches.length === 1 ? matches[0] : undefined);
    if (candidate && !Object.hasOwn(result, candidate.id))
      result[candidate.id] = target.id;
  }
  return result;
}
export function buildAppendStep(
  id: string,
  inputs: Array<{ id: string; mapping?: Record<string, string> }>,
): Extract<PreparationNode, { type: "append" }> {
  const mapped = inputs.filter((input) => input.mapping !== undefined);
  if (mapped.some((input) => Object.keys(input.mapping!).length === 0))
    throw new DataProcessingError("preparation_append_mapping_invalid");
  return {
    id,
    type: "append",
    inputs: inputs.map((input) => input.id),
    ...(mapped.length
      ? {
          columnMappings: Object.fromEntries(
            mapped.map((input) => [input.id, input.mapping!]),
          ),
        }
      : {}),
  };
}
