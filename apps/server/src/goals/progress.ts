import type { MetricQueryResponse } from "@netrics/contracts";
import type { GoalRow, Transaction } from "@netrics/database";
import {
  goalProgress,
  type GoalAggregation,
  type GoalPeriod,
  type GoalProgress,
  type Locale,
} from "@netrics/domain";

import { queryMetric, type MetricCoverage } from "../metrics/query.js";

/**
 * A goal's metric read now and where the goal stands (ADR 0019 sections 4
 * and 5): one function for the Goals API and the goal widget's payload, so
 * both always agree.
 */
export interface GoalReading {
  /** The metric query over the goal's current period. */
  read: MetricQueryResponse;
  progress: GoalProgress;
}

/**
 * Reads a goal's metric over its current period in a savepoint (a failing
 * read leaves the caller's transaction usable) and computes its progress.
 * Null when the metric cannot be read, or when a converted goal cannot be
 * read in its currency (without exchange rates its target would mean
 * something else). With `coverage` (the read days of the goal's metric,
 * ADR 0025 section 9), a period the source read and found quiet stands at
 * 0 rather than without a value (#799): the metric query's own rule.
 */
export async function readGoal(
  tx: Transaction,
  workspaceId: string,
  goal: GoalRow,
  at: Date,
  options: {
    exchangeRates: boolean;
    locale: Locale;
    coverage?: MetricCoverage | undefined;
  },
): Promise<GoalReading | null> {
  try {
    const result = await tx.transaction((inner) =>
      queryMetric(
        inner,
        workspaceId,
        {
          connectionId: goal.connectionId,
          metricKey: goal.metricKey,
          period: goal.period as GoalPeriod,
          aggregation: goal.aggregation as GoalAggregation,
          dimensions: goal.dimensions as Record<string, string>,
          ...(goal.displayCurrency
            ? { displayCurrency: goal.displayCurrency }
            : {}),
        },
        at,
        {
          exchangeRates: options.exchangeRates,
          locale: options.locale,
          ...(options.coverage ? { coverage: options.coverage } : {}),
        },
      ),
    );
    if (!result.ok) {
      return null;
    }
    const read = result.value;
    if (
      goal.displayCurrency !== null &&
      read.currency !== goal.displayCurrency
    ) {
      return null;
    }
    return {
      read,
      progress: goalProgress({
        target: goal.target,
        aggregation: goal.aggregation as GoalAggregation,
        kind: read.metric.kind,
        value: read.value,
        series: read.series,
        period: goal.period as GoalPeriod,
        now: at,
        timeZone: read.timeZone,
      }),
    };
  } catch {
    return null;
  }
}
