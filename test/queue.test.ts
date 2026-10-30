import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatQueue } from "../src/queue.js";
import { chat } from "./helpers.js";

test("paid messages and events jump the line, then questions and mentions", () => {
  const now = Date.now();
  const queue = new ChatQueue({ characterName: "Crumb" });
  queue.push(chat("hello everyone", { user: "a", ts: now }));
  queue.push(chat("what is your favorite bread?", { user: "b", ts: now }));
  queue.push(chat("crumb you rock", { user: "c", ts: now }));
  queue.push(chat("take my money", { user: "d", ts: now, paid: { amount: 5, currency: "USD", display: "$5" } }));
  queue.push(chat("", { user: "e", ts: now, event: "sub", eventText: "e subscribed" }));
  assert.deepEqual(
    [queue.next(now), queue.next(now), queue.next(now), queue.next(now), queue.next(now)].map((m) => m?.user),
    ["d", "e", "c", "b", "a"],
  );
  assert.equal(queue.next(now), undefined);
});

test("stale unpaid chat is dropped, paid chat waits longer", () => {
  const now = Date.now();
  const queue = new ChatQueue({ characterName: "Crumb", maxAgeMs: 10_000, maxPriorityAgeMs: 60_000 });
  queue.push(chat("old question?", { ts: now - 20_000 }));
  queue.push(chat("old but paid", { ts: now - 20_000, paid: { amount: 2, currency: "USD", display: "$2" } }));
  assert.equal(queue.next(now)?.text, "old but paid");
  assert.equal(queue.next(now), undefined);
});

test("someone who was just answered goes to the back", () => {
  const now = Date.now();
  const queue = new ChatQueue({ characterName: "Crumb" });
  const first = chat("crumb rate my code?", { user: "hog", ts: now });
  queue.markReplied(first, now);
  queue.push(first);
  queue.push(chat("hi there friends", { user: "newbie", ts: now }));
  assert.equal(queue.next(now)?.user, "newbie");
});

test("the queue never grows past maxSize", () => {
  const now = Date.now();
  const queue = new ChatQueue({ characterName: "Crumb", maxSize: 5 });
  for (let i = 0; i < 20; i++) queue.push(chat(`message number ${i}`, { user: `u${i}`, ts: now }));
  assert.equal(queue.size, 5);
});
