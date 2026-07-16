import assert from "node:assert/strict";
import test from "node:test";

import {
  createCsgclawWorkLeaseReporter,
  resetWorkLeaseCompatibilityBreakersForTest,
} from "../dist/src/work-lease.js";

const account = {
  accessToken: "secret",
  accountId: "default",
  baseUrl: "http://127.0.0.1:8080/base",
  botId: "pt-worker",
  enabled: true,
  participantId: "pt-worker",
};

function reporterOptions(fetchImpl, overrides = {}) {
  return {
    account,
    fetchImpl,
    leaseId: "00000000-0000-4000-8000-000000000001",
    participantId: "pt-worker",
    requestId: "message-1",
    requestTimeoutMs: 50,
    roomId: "room-1",
    ...overrides,
  };
}

test.beforeEach(() => resetWorkLeaseCompatibilityBreakersForTest());

test("starts, renews with one lease id, and releases", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ body: init.body, method: init.method, url: String(url) });
    return new Response(null, { status: init.method === "DELETE" ? 204 : 200 });
  };
  const reporter = createCsgclawWorkLeaseReporter(reporterOptions(fetchImpl));
  await reporter.startOrRenew();
  await reporter.startOrRenew();
  await reporter.stop();
  const stoppedAt = calls.length;
  await reporter.startOrRenew();

  assert.equal(calls.filter((call) => call.method === "PUT").length, 2);
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
  assert.equal(calls.length, stoppedAt);
  assert.ok(calls.every((call) => call.url.endsWith("/work-leases/00000000-0000-4000-8000-000000000001")));
  const putBodies = calls.filter((call) => call.method === "PUT").map((call) => JSON.parse(call.body));
  assert.ok(putBodies.every((body) => body.room_id === "room-1" && body.ttl_seconds === 15));
});

test("keeps at most one PUT in flight and stop aborts it before DELETE", async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(init.method);
    if (init.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return await new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  };
  const reporter = createCsgclawWorkLeaseReporter(reporterOptions(fetchImpl));
  const firstPut = reporter.startOrRenew();
  await reporter.startOrRenew();
  assert.deepEqual(calls, ["PUT"]);
  await reporter.stop();
  await firstPut;
  assert.deepEqual(calls, ["PUT", "DELETE"]);
});

test("legacy server statuses pause the account and log once", async () => {
  let now = 1_000;
  let requestCount = 0;
  const warnings = [];
  const fetchImpl = async () => {
    requestCount += 1;
    return new Response(null, { status: 404 });
  };
  const options = reporterOptions(fetchImpl, {
    log: { warn: (message) => warnings.push(message) },
    now: () => now,
  });
  const first = createCsgclawWorkLeaseReporter(options);
  await first.startOrRenew();
  await first.stop();
  const second = createCsgclawWorkLeaseReporter({ ...options, leaseId: "00000000-0000-4000-8000-000000000002" });
  await second.startOrRenew();
  await second.stop();

  assert.equal(requestCount, 1);
  assert.equal(warnings.filter((message) => message.includes("pausing reporter")).length, 1);

  now += 5 * 60_000 + 1;
  const probe = createCsgclawWorkLeaseReporter({ ...options, leaseId: "00000000-0000-4000-8000-000000000003" });
  await probe.startOrRenew();
  assert.equal(requestCount, 2);
  await probe.stop();
});

test("timeouts and 5xx responses do not open the compatibility breaker", async () => {
  let requestCount = 0;
  const fetchImpl = async (_url, init) => {
    requestCount += 1;
    if (requestCount === 1) {
      return new Response(null, { status: 503 });
    }
    return await new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  };
  const reporter = createCsgclawWorkLeaseReporter(reporterOptions(fetchImpl, { requestTimeoutMs: 5 }));
  await reporter.startOrRenew();
  await reporter.startOrRenew();
  assert.equal(requestCount, 2);
  await reporter.stop();
});
