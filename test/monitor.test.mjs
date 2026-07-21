import assert from "node:assert/strict";
import test from "node:test";

import { BoundedDispatchQueue } from "../dist/src/monitor.js";

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("bounded dispatch queue preserves order and rejects overflow", async () => {
  const order = [];
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const queue = new BoundedDispatchQueue(1);

  assert.equal(
    queue.enqueue(async () => {
      order.push("first:start");
      await firstBlocked;
      order.push("first:end");
    }),
    true,
  );
  assert.equal(
    queue.enqueue(async () => {
      order.push("second");
    }),
    true,
  );
  assert.equal(
    queue.enqueue(async () => {
      order.push("overflow");
    }),
    false,
  );

  assert.deepEqual(order, ["first:start"]);
  releaseFirst();
  await waitFor(() => order.includes("second"));
  assert.deepEqual(order, ["first:start", "first:end", "second"]);
});

test("closing the dispatch queue drops pending work and rejects new work", async () => {
  const order = [];
  let releaseRunning;
  const runningBlocked = new Promise((resolve) => {
    releaseRunning = resolve;
  });
  const queue = new BoundedDispatchQueue(1);

  queue.enqueue(async () => {
    order.push("running:start");
    await runningBlocked;
    order.push("running:end");
  });
  queue.enqueue(async () => {
    order.push("pending");
  });

  queue.close();
  assert.equal(queue.enqueue(async () => {}), false);
  releaseRunning();
  await waitFor(() => order.includes("running:end"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(order, ["running:start", "running:end"]);
});
