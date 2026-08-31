/** Runs works one at a time in arrival order; one failing does not break the chain. */
export function serializer(): <T>(work: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return (work) => {
    const run = chain.then(work, work);
    chain = run.catch(() => {});
    return run;
  };
}
