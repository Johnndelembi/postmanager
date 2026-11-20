import assert from "node:assert/strict";
import test from "node:test";

import { nextQueueTime } from "../netlify/lib/posts.js";

test("queue slots use Tanzania time and skip a reserved slot", () => {
  const now = new Date("2026-11-20T05:30:00Z"); // 08:30 EAT
  const first = new Date("2026-11-20T06:00:00Z"); // 09:00 EAT
  assert.equal(nextQueueTime(now, ["18:00", "09:00"], []).toISOString(), first.toISOString());
  assert.equal(
    nextQueueTime(now, ["18:00", "09:00"], [first]).toISOString(),
    "2026-11-20T15:00:00.000Z",
  );
  assert.equal(
    nextQueueTime(new Date("2026-11-20T15:00:00Z"), ["18:00", "09:00"], []).toISOString(),
    "2026-11-21T06:00:00.000Z",
  );
});
