import assert from "node:assert/strict";
import test from "node:test";

import {
  createCsgclawWorkLeaseReporter,
  dispatchWithCsgclawWorkLease,
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

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

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
      init.signal.addEventListener("abort", () => reject(init.signal.reason), {
        once: true,
      });
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
  const second = createCsgclawWorkLeaseReporter({
    ...options,
    leaseId: "00000000-0000-4000-8000-000000000002",
  });
  await second.startOrRenew();
  await second.stop();

  assert.equal(requestCount, 1);
  assert.equal(warnings.filter((message) => message.includes("pausing reporter")).length, 1);

  now += 5 * 60_000 + 1;
  const probe = createCsgclawWorkLeaseReporter({
    ...options,
    leaseId: "00000000-0000-4000-8000-000000000003",
  });
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
      init.signal.addEventListener("abort", () => reject(init.signal.reason), {
        once: true,
      });
    });
  };
  const reporter = createCsgclawWorkLeaseReporter(reporterOptions(fetchImpl, { requestTimeoutMs: 5 }));
  await reporter.startOrRenew();
  await reporter.startOrRenew();
  assert.equal(requestCount, 2);
  await reporter.stop();
});

test("dispatch lifecycle starts before dispatch and stops after delivery", async () => {
  const order = [];
  const reporter = {
    async startOrRenew() {
      order.push("start");
    },
    async stop() {
      order.push("stop");
    },
  };

  const result = await dispatchWithCsgclawWorkLease({
    dispatch: async () => {
      order.push("dispatch");
      await Promise.resolve();
      order.push("delivered");
      return "ok";
    },
    reporter,
  });

  assert.equal(result, "ok");
  assert.deepEqual(order, ["start", "dispatch", "delivered", "stop"]);
});

test("dispatch lifecycle renews independently of OpenClaw typing", async () => {
  let renewCount = 0;
  let stopCount = 0;
  const reporter = {
    async startOrRenew() {
      renewCount += 1;
    },
    async stop() {
      stopCount += 1;
    },
  };

  await dispatchWithCsgclawWorkLease({
    dispatch: async () => await new Promise((resolve) => setTimeout(resolve, 25)),
    renewIntervalMs: 5,
    reporter,
  });

  assert.ok(renewCount >= 2);
  assert.equal(stopCount, 1);
});

test("reporting failures do not mask dispatch results or errors", async () => {
  const warnings = [];
  const reporter = {
    async startOrRenew() {
      throw new Error("start unavailable");
    },
    async stop() {
      throw new Error("stop unavailable");
    },
  };

  const result = await dispatchWithCsgclawWorkLease({
    dispatch: async () => "reply delivered",
    log: { warn: (message) => warnings.push(message) },
    reporter,
  });
  assert.equal(result, "reply delivered");
  assert.equal(warnings.length, 2);

  const dispatchError = new Error("dispatch failed");
  await assert.rejects(
    dispatchWithCsgclawWorkLease({
      dispatch: async () => {
        throw dispatchError;
      },
      reporter: {
        async startOrRenew() {},
        async stop() {},
      },
    }),
    (error) => error === dispatchError,
  );
});

test("negotiates capabilities and reports bounded full thinking snapshots", async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push({
      body: init.body ? JSON.parse(init.body) : undefined,
      method: init.method,
    });
    return new Response(JSON.stringify({ stop_requested_at: null }), {
      headers: { "Content-Type": "application/json" },
      status: init.method === "DELETE" ? 200 : 200,
    });
  };
  const reporter = createCsgclawWorkLeaseReporter(reporterOptions(fetchImpl, { statusIntervalMs: 1 }));
  await reporter.startOrRenew();
  await waitFor(() => calls.some((call) => call.method === "PATCH"));
  const initial = calls.find((call) => call.method === "PATCH");
  assert.deepEqual(initial.body.capabilities, ["thinking_status_v1", "turn_stop_v1"]);
  assert.equal(initial.body.sequence, 1);
  assert.equal(initial.body.phase, "working");

  await reporter.updateStatus({
    phase: "thinking",
    thinking: { text: `prefix\u0000\r\n${"界".repeat(8_000)}` },
  });
  await waitFor(() => calls.filter((call) => call.method === "PATCH").length >= 2);
  const thinking = calls.filter((call) => call.method === "PATCH").at(-1).body;
  assert.equal(thinking.phase, "thinking");
  assert.equal(thinking.thinking.format, "plain_text");
  assert.equal(thinking.thinking.truncated, true);
  assert.ok(Buffer.byteLength(thinking.thinking.text, "utf8") <= 16 * 1024);
  assert.equal(thinking.thinking.text.includes("\u0000"), false);
  assert.equal(thinking.thinking.text.includes("\r"), false);
  await reporter.stop();
});

test("PUT stop markers notify once", async () => {
  let requestCount = 0;
  const fetchImpl = async (_url, init) => {
    requestCount += 1;
    return new Response(
      init.method === "DELETE" ? null : JSON.stringify({ stop_requested_at: "2026-07-20T03:00:08Z" }),
      {
        headers: { "Content-Type": "application/json" },
        status: init.method === "DELETE" ? 204 : 200,
      },
    );
  };
  const reporter = createCsgclawWorkLeaseReporter(reporterOptions(fetchImpl, { statusIntervalMs: 1_000 }));
  let stopped = 0;
  reporter.onStopRequested(() => {
    stopped += 1;
  });
  await reporter.startOrRenew();
  await reporter.startOrRenew();
  assert.equal(stopped, 1);
  assert.equal(requestCount, 2);
  await reporter.stop();
});

test("PATCH stop markers notify once", async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(init.method);
    const body =
      init.method === "PATCH"
        ? JSON.stringify({ stop_requested_at: "2026-07-20T03:00:08Z" })
        : init.method === "PUT"
          ? JSON.stringify({ stop_requested_at: null })
          : null;
    return new Response(body, {
      headers: { "Content-Type": "application/json" },
      status: init.method === "DELETE" ? 204 : 200,
    });
  };
  const reporter = createCsgclawWorkLeaseReporter(reporterOptions(fetchImpl, { statusIntervalMs: 1 }));
  let stopped = 0;
  reporter.onStopRequested(() => {
    stopped += 1;
  });

  await reporter.startOrRenew();
  await waitFor(() => calls.includes("PATCH"));
  await reporter.startOrRenew();

  assert.equal(stopped, 1);
  assert.equal(calls.filter((method) => method === "PATCH").length, 1);
  await reporter.stop();
});

test("legacy PATCH breaker does not pause PUT or DELETE", async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(init.method);
    if (init.method === "PATCH") {
      return new Response(null, { status: 404 });
    }
    return new Response(null, { status: init.method === "DELETE" ? 204 : 200 });
  };
  const reporter = createCsgclawWorkLeaseReporter(reporterOptions(fetchImpl, { statusIntervalMs: 1 }));
  await reporter.startOrRenew();
  await waitFor(() => calls.includes("PATCH"));
  await reporter.startOrRenew();
  await reporter.updateStatus({
    phase: "thinking",
    thinking: { text: "new snapshot" },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await reporter.stop();

  assert.equal(calls.filter((method) => method === "PATCH").length, 1);
  assert.equal(calls.filter((method) => method === "PUT").length, 2);
  assert.equal(calls.filter((method) => method === "DELETE").length, 1);
});
