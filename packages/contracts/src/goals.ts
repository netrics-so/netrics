import { z } from "zod";

import {
  AGGREGATIONS,
  GOAL_AGGREGATIONS,
  GOAL_LIMITS,
  GOAL_PERIODS,
  PERIODS,
} from "@netrics/domain";

// Goals (ADR 0019 section 4, #335): a named target for one metric in a
// period to date. Self-contained (zod and the domain only), so the main
// contract module can re-export it without an import cycle.

export const goalPeriodSchema = z.enum(GOAL_PERIODS);
export type GoalPeriodValue = z.infer<typeof goalPeriodSchema>;

export const goalAggregationSchema = z.enum(GOAL_AGGREGATIONS);
export type GoalAggregationValue = z.infer<typeof goalAggregationSchema>;

/**
 * Where a goal stands in its current period: the fields the Goals page
 * shows and the gauge widget's payload carries (ADR 0019 §5).
 */
export const goalProgressSchema = z.object({
  /** The metric's value so far, in payload units; null without data. */
  value: z.number().nullable(),
  /** In payload units (minor units, 0–1 for a ratio). */
  target: z.number(),
  /** value ÷ target, not clipped (1.22 is 122 %); null without data. */
  progress: z.number().nullable(),
  /**
   * Start of the bucket where the running sum first reached the target (a
   * sum of a delta metric only), else null.
   */
  reachedAt: z.iso.datetime({ offset: true }).nullable(),
  /** Exclusive end of the period, with the workspace zone's offset. */
  periodEnd: z.iso.datetime({ offset: true }),
});
export type GoalProgressView = z.infer<typeof goalProgressSchema>;

/** The current period's progress as the Goals page shows it. */
export const goalCurrentSchema = goalProgressSchema.extend({
  /** ISO 4217 code of an amount (value and target in its minor units). */
  currency: z.string().nullable(),
  /** Converted into a display currency: show the value as approximate. */
  approximate: z.boolean(),
});
export type GoalCurrent = z.infer<typeof goalCurrentSchema>;

export const goalSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  connectionId: z.uuid(),
  metricKey: z.string().min(1),
  aggregation: goalAggregationSchema,
  period: goalPeriodSchema,
  dimensions: z.record(z.string(), z.string()),
  /** Amounts converted into this currency (#191), else null. */
  displayCurrency: z.string().nullable(),
  target: z.number(),
  /** Send it back with PUT; a newer version on the server answers 409. */
  version: z.number().int().min(1),
  /** Name of the resource the goal is for (its "resource" filter), if known. */
  resourceName: z.string().nullable(),
  /** "All apps" for a goal over several resources added up (#208). */
  allResourcesName: z.string().nullable(),
  /**
   * Progress in the current period; null when the metric cannot be read
   * right now (the goal itself is fine).
   */
  current: goalCurrentSchema.nullable(),
  /**
   * Dashboards whose gauge widgets show the goal (#339), so deleting can be
   * confirmed by name ("Used on 2 dashboards").
   */
  dashboards: z.array(z.object({ id: z.uuid(), name: z.string() })),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Goal = z.infer<typeof goalSchema>;

export const goalListResponseSchema = z.object({ goals: z.array(goalSchema) });
export type GoalListResponse = z.infer<typeof goalListResponseSchema>;

export const goalResponseSchema = z.object({ goal: goalSchema });
export type GoalResponse = z.infer<typeof goalResponseSchema>;

/**
 * A goal as created or replaced. Aggregation and period accept every value
 * a widget does, so a goal that cannot be one is refused with its own code:
 * 400 aggregation_not_supported (not `sum` or `last`), period_not_supported
 * (a rolling period), goal_direction_unsupported (lower is better) and
 * currency_required (a per-currency amount without one fixed currency);
 * the binding is otherwise checked like a widget's.
 */
export const goalInputSchema = z.object({
  name: z.string().trim().min(1).max(GOAL_LIMITS.nameLength),
  connectionId: z.uuid(),
  metricKey: z.string().min(1).max(200),
  /** Defaults to the metric's first compatible aggregation. */
  aggregation: z.enum(AGGREGATIONS).optional(),
  period: z.enum(PERIODS),
  /** Filters as on widgets, including "resource" and "currency". */
  dimensions: z
    .record(z.string().min(1).max(100), z.string().max(200))
    .refine((dimensions) => Object.keys(dimensions).length <= 10, {
      message: "at most 10 dimension filters",
    })
    .optional(),
  displayCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/, { message: "expected an ISO 4217 code such as EUR" })
    .nullable()
    .optional(),
  /** In payload units: minor units for amounts, 0–1 for a ratio. */
  target: z.number().positive().max(GOAL_LIMITS.maxTarget),
});

export const createGoalRequestSchema = goalInputSchema;
export type CreateGoalRequest = z.input<typeof createGoalRequestSchema>;

export const updateGoalRequestSchema = goalInputSchema.extend({
  version: z.number().int().min(1),
});
export type UpdateGoalRequest = z.input<typeof updateGoalRequestSchema>;

/**
 * A deleted goal: the dashboards whose gauges used it (they now show "Goal
 * deleted"). Deleting succeeds either way; the UI confirms first.
 */
export const deleteGoalResponseSchema = z.object({
  dashboards: z.array(z.object({ id: z.uuid(), name: z.string() })),
});
export type DeleteGoalResponse = z.infer<typeof deleteGoalResponseSchema>;
