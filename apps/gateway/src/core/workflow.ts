/** One durable, retried step: `step.do` in the Workflow, a plain call in tests. */
export type StepFn = <T>(name: string, fn: () => Promise<T>) => Promise<T>;
