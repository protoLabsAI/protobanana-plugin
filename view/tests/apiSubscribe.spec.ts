import { test, expect } from "@playwright/test";

// api.ts subscribe() unit test. The operator walkthrough (PR #44) found the view
// never received ANY bus event because subscribe() posted the wrong frame:
// `{ type: "protoagent:subscribe", topic }`. The host relay
// (protoAgent apps/web/src/lib/pluginEventRelay.ts, `parseSubscribe`) requires
// `{ type: "protoagent:subscribe", patterns: string[] }` and drops anything else,
// so every subscribe was silently dropped and no protobanana.* topic ever landed
// in the Images view. These tests pin the host contract so that can't drift back.
//
// Faithful copy of the host relay's `parseSubscribe` (cited above) — the contract
// the posted frame must satisfy; a drift here is a drift in the plugin.
function parseSubscribe(msg: unknown): { patterns: string[] } | null {
  const m = msg as { type?: unknown; patterns?: unknown };
  if (!m || typeof m !== "object" || m.type !== "protoagent:subscribe") return null;
  if (!Array.isArray(m.patterns) || !m.patterns.every((p) => typeof p === "string")) return null;
  return { patterns: m.patterns as string[] };
}

test("subscribe() posts the full host-contract pattern set and dispatches events by topic", async ({ page }) => {
  // The harness imports ONLY api.ts, so the subscribe map starts empty.
  await page.route("**/_ds/**", (route) => route.fulfill({ body: "", contentType: "text/javascript" }));
  await page.goto("/tests/fixtures/api-harness.html");
  await page.waitForFunction(() => Boolean((window as { __subscribe?: unknown }).__subscribe));

  const out = await page.evaluate(async () => {
    const subscribe = (window as unknown as {
      __subscribe: (topic: string, handler: (data: unknown) => void) => () => void;
    }).__subscribe;

    // Capture every subscribe frame the view posts to its parent (here, self).
    const posts: { patterns: unknown; since: unknown }[] = [];
    window.addEventListener("message", (e: MessageEvent) => {
      const d = e.data as { type?: string; patterns?: unknown; since?: unknown } | null;
      if (d && d.type === "protoagent:subscribe") posts.push({ patterns: d.patterns, since: d.since });
    });

    const seen: Record<string, unknown[]> = { a: [], b: [] };
    const flush = () => new Promise((r) => setTimeout(r, 25));

    const offA = subscribe("topic.a", (d) => seen.a.push(d));
    const offB = subscribe("topic.b", (d) => seen.b.push(d));
    const offA2 = subscribe("topic.a", () => {}); // 2nd handler, SAME topic → no new frame
    await flush();

    // A matching event for topic.a only; its seq must drive future `since`.
    window.postMessage({ type: "protoagent:event", topic: "topic.a", data: { n: 1 }, seq: 7 }, "*");
    // An event for a topic with no handler must reach nobody and not throw.
    window.postMessage({ type: "protoagent:event", topic: "topic.c", data: { n: 9 }, seq: 8 }, "*");
    await flush();

    offB(); // removes topic.b's only handler → re-post WITHOUT it
    await flush();
    const afterB = posts.length;

    offA(); // topic.a still has offA2's handler → no re-post
    await flush();
    const afterA1 = posts.length;

    offA2(); // last topic.a handler → re-post (now empty)
    await flush();

    return { posts, seen, afterB, afterA1 };
  });

  // Each frame carries the FULL current topic set (the relay replaces the set).
  expect(out.posts[0].patterns).toEqual(["topic.a"]);
  expect(out.posts[1].patterns).toEqual(["topic.a", "topic.b"]);
  // Adding a 2nd handler to an existing topic posts nothing new.
  expect(out.posts).toHaveLength(4);
  // Unsubscribing topic.b's last handler re-posts the set without it...
  expect(out.afterB).toBe(3);
  expect(out.posts[2].patterns).toEqual(["topic.a"]);
  // ...and `since` is the HIGHEST seq seen across all relayed frames (7, then 8),
  // so a re-subscribe asks the relay to replay only genuinely newer events.
  expect(out.posts[2].since).toBe(8);
  // Dropping one of two handlers on a topic does NOT re-post.
  expect(out.afterA1).toBe(3);
  // The last handler leaving empties the set.
  expect(out.posts[3].patterns).toEqual([]);

  // The event reached ONLY topic.a's handler; topic.c (unsubscribed) reached nobody.
  expect(out.seen.a).toEqual([{ n: 1 }]);
  expect(out.seen.b).toEqual([]);

  // Drift guard: the OLD per-topic `{ topic }` frame is NOT accepted by the host —
  // if the plugin ever regresses to it, the relay drops the subscribe (the bug).
  expect(parseSubscribe({ type: "protoagent:subscribe", topic: "topic.a" })).toBeNull();
  // ...while the shape we now post IS accepted.
  expect(parseSubscribe(out.posts[1] && { type: "protoagent:subscribe", patterns: out.posts[1].patterns }))
    .toEqual({ patterns: ["topic.a", "topic.b"] });
});
