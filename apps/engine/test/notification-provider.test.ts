import { afterEach, expect, it, vi } from "vitest";
import {
  HttpNotificationProvider,
  createNotificationCipher,
} from "../src/providers/notification-provider.js";
const signal = new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());
it("verifies Slack without posting and sends literal text without mentions or previews", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ ok: true, bot_id: "B1" }))
    .mockResolvedValueOnce(
      Response.json({
        ok: true,
        channel: { id: "C123456", is_member: true, is_archived: false },
      }),
    )
    .mockResolvedValueOnce(Response.json({ ok: true, ts: "123.456" }));
  vi.stubGlobal("fetch", fetcher);
  const provider = new HttpNotificationProvider();
  const config = {
    kind: "slack" as const,
    token: "xoxb-synthetic",
    destination: "C123456",
  };
  await provider.verify(config, signal);
  expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
    "https://slack.com/api/auth.test",
    "https://slack.com/api/conversations.info",
  ]);
  await expect(
    provider.send(config, "Remember <!channel>", signal),
  ).resolves.toEqual({ messageId: "123.456" });
  expect(JSON.parse(fetcher.mock.calls[2]![1].body)).toMatchObject({
    text: "Remember &lt;!channel&gt;",
    mrkdwn: false,
    parse: "none",
    unfurl_links: false,
    unfurl_media: false,
  });
});
it("distinguishes explicit throttling from ambiguous Telegram transport failures without leaking tokens", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        { ok: false, error_code: 429, parameters: { retry_after: 67 } },
        { status: 429 },
      ),
    )
    .mockRejectedValueOnce(
      new Error("https://api.telegram.org/bot123:secret/sendMessage"),
    );
  vi.stubGlobal("fetch", fetcher);
  const provider = new HttpNotificationProvider();
  const config = {
    kind: "telegram" as const,
    token: "123:secret",
    destination: "-100123",
  };
  await expect(provider.send(config, "Reminder", signal)).rejects.toMatchObject(
    {
      code: "NOTIFICATION_RATE_LIMITED",
      outcome: "retry",
      retryAfterSeconds: 67,
    },
  );
  const error = await provider
    .send(config, "Reminder", signal)
    .catch((error) => error);
  expect(error).toMatchObject({
    code: "NOTIFICATION_DELIVERY_UNCERTAIN",
    outcome: "uncertain",
  });
  expect(JSON.stringify(error) + error.stack).not.toContain("123:secret");
});
it("binds encrypted channel credentials to the channel identity", () => {
  const cipher = createNotificationCipher(Buffer.alloc(32, 7));
  const envelope = cipher.encrypt("channel-a", {
    kind: "telegram",
    token: "123:secret",
    destination: "42",
  });
  expect(envelope).not.toContain("secret");
  expect(cipher.decrypt("channel-a", envelope)).toMatchObject({
    token: "123:secret",
  });
  expect(() => cipher.decrypt("channel-b", envelope)).toThrow(
    "NOTIFICATION_CONFIGURATION_UNAVAILABLE",
  );
});
