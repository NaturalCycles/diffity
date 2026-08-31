import { describe, it, expect } from 'vitest';
import { serializer } from '../src/serialize.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('one at a time', () => {
  it('a second work does not start until the first finishes', async () => {
    const oneAtATime = serializer();
    const gate = deferred<string>();
    const events: string[] = [];

    const first = oneAtATime(async () => {
      events.push('first started');
      const value = await gate.promise;
      events.push('first finished');
      return value;
    });
    const second = oneAtATime(async () => {
      events.push('second started');
      return 'two';
    });

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(events).toEqual(['first started']);

    gate.resolve('one');
    await expect(first).resolves.toBe('one');
    await expect(second).resolves.toBe('two');
    expect(events).toEqual(['first started', 'first finished', 'second started']);
  });

  it('one failing does not break the chain, and each caller gets its own outcome', async () => {
    const oneAtATime = serializer();

    const failing = oneAtATime(async () => {
      throw new Error('boom');
    });
    const following = oneAtATime(async () => 'still runs');

    await expect(failing).rejects.toThrowError('boom');
    await expect(following).resolves.toBe('still runs');
  });
});
