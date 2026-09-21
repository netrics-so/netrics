# Milestone 10 — Projects and derived metrics

## Outcome

Teams can organize connections and dashboards by project and calculate useful
cross-source metrics without writing code.

## Dependencies

- Milestones 04–09

## In scope

- Complete project creation, editing, archive, and navigation
- Optional project assignment for connections and dashboards
- Workspace-wide dashboards that combine several projects
- Project-aware filtering without weakening workspace isolation
- Derived metric definitions and restricted expression grammar
- References to normalized metrics from several connections
- Unit, currency, dimension, time-window, and aggregation validation
- Missing-value, zero-division, and stale-input behavior
- Preview with sample and historical data
- Additional bar, table, gauge, and health widgets

## Out of scope

- Project-specific memberships
- General SQL or arbitrary JavaScript expressions
- Currency exchange
- Machine-learning forecasts

## Implementation slices

1. Finish project navigation and optional resource assignment.
2. Define a stable metric-reference syntax.
3. Implement the restricted expression parser and validator.
4. Add query planning for aligned time windows and dimensions.
5. Implement unit, currency, and aggregation compatibility.
6. Build derived-metric creation, preview, and error UX.
7. Add the remaining v1 widgets.
8. Add cross-project and cross-connection scenarios.

## Verification

- Moving a resource between projects preserves history and permissions.
- Workspace-wide dashboards can combine project metrics.
- Invalid unit, currency, dimension, and aggregation combinations fail before
  saving.
- Derived queries remain bounded and tenant-scoped.
- Missing or stale inputs produce an explicit result state.

## Exit gate

Create projects for acquisition and product, connect metrics from different
providers, define a cross-source conversion metric, and display it with correct
units and stale-data behavior on a workspace-wide dashboard.
