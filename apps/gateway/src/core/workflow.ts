export type StepFn = <T>(name: string, fn: () => Promise<T>) => Promise<T>;
