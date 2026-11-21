import type { BuilderState } from "@/lib/custom-api-builder";

/** What every builder step gets: the state and a way to change it. */
export interface StepProps {
  state: BuilderState;
  update: (change: (current: BuilderState) => BuilderState) => void;
}
