import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  NotificationError,
  type NotificationCipher,
  type NotificationConfig,
  type NotificationProvider,
} from "../domain/notifications.js";
const configSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("slack"),
    token: z
      .string()
      .regex(/^xoxb-[A-Za-z0-9-]+$/u)
      .max(500),
    destination: z.string().regex(/^[CGD][A-Z0-9]{5,30}$/u),
  }),
  z.object({
    kind: z.literal("telegram"),
    token: z
      .string()
      .regex(/^\d+:[A-Za-z0-9_-]+$/u)
      .max(500),
    destination: z.string().regex(/^-?\d{1,20}$/u),
  }),
]);
export function validateNotificationConfig(
  config: NotificationConfig,
): NotificationConfig {
  const decoded = configSchema.safeParse(config);
  if (!decoded.success)
    throw new NotificationError(
      "failed",
      "NOTIFICATION_CONFIGURATION_UNAVAILABLE",
    );
  return decoded.data;
}
export function createNotificationCipher(
  key: Uint8Array | null,
): NotificationCipher {
  function requireKey() {
    if (key === null || key.byteLength !== 32)
      throw new NotificationError(
        "failed",
        "NOTIFICATION_CONFIGURATION_UNAVAILABLE",
      );
    return key;
  }
  return {
    encrypt(id, config) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", requireKey(), iv);
      cipher.setAAD(Buffer.from(`second-brain:notification:v1:${id}`));
      const encrypted = Buffer.concat([
        cipher.update(
          JSON.stringify(validateNotificationConfig(config)),
          "utf8",
        ),
        cipher.final(),
      ]);
      return [
        "v1",
        iv.toString("base64url"),
        encrypted.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
      ].join(".");
    },
    decrypt(id, envelope) {
      try {
        const [version, iv, data, tag, ...extra] = envelope.split(".");
        if (version !== "v1" || !iv || !data || !tag || extra.length)
          throw new Error();
        const decipher = createDecipheriv(
          "aes-256-gcm",
          requireKey(),
          Buffer.from(iv, "base64url"),
        );
        decipher.setAAD(Buffer.from(`second-brain:notification:v1:${id}`));
        decipher.setAuthTag(Buffer.from(tag, "base64url"));
        return validateNotificationConfig(
          JSON.parse(
            Buffer.concat([
              decipher.update(Buffer.from(data, "base64url")),
              decipher.final(),
            ]).toString("utf8"),
          ),
        );
      } catch {
        throw new NotificationError(
          "failed",
          "NOTIFICATION_CONFIGURATION_UNAVAILABLE",
        );
      }
    },
  };
}
const object = z.record(z.string(), z.unknown());
export class HttpNotificationProvider implements NotificationProvider {
  private async request(
    config: NotificationConfig,
    method: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
    sending = false,
  ): Promise<Record<string, unknown>> {
    validateNotificationConfig(config);
    signal.throwIfAborted();
    try {
      const response = await fetch(
        config.kind === "slack"
          ? `https://slack.com/api/${method}`
          : `https://api.telegram.org/bot${config.token}/${method}`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            "content-type": "application/json",
            ...(config.kind === "slack"
              ? { authorization: `Bearer ${config.token}` }
              : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        },
      );
      if (response.status === 429) {
        const data = z
          .object({
            parameters: z.object({ retry_after: z.number() }).optional(),
          })
          .safeParse(await response.json().catch(() => ({})));
        const seconds = Number(
          response.headers.get("retry-after") ??
            (data.success ? data.data.parameters?.retry_after : undefined) ??
            30,
        );
        throw new NotificationError(
          "retry",
          "NOTIFICATION_RATE_LIMITED",
          Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : 30,
        );
      }
      if (response.status >= 500)
        throw new NotificationError(
          sending ? "uncertain" : "failed",
          sending ? "NOTIFICATION_DELIVERY_UNCERTAIN" : "NOTIFICATION_REJECTED",
        );
      const data = object.parse(await response.json());
      if (!response.ok || data.ok !== true) {
        if (data.error_code === 429 || data.error === "ratelimited") {
          const params = object.safeParse(data.parameters);
          const seconds = Number(params.success ? params.data.retry_after : 30);
          throw new NotificationError(
            "retry",
            "NOTIFICATION_RATE_LIMITED",
            Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : 30,
          );
        }
        if (
          sending &&
          (data.error === "internal_error" || data.error === "fatal_error")
        )
          throw new NotificationError(
            "uncertain",
            "NOTIFICATION_DELIVERY_UNCERTAIN",
          );
        throw new NotificationError("failed", "NOTIFICATION_REJECTED");
      }
      return data;
    } catch (error) {
      if (error instanceof NotificationError) throw error;
      throw new NotificationError(
        sending ? "uncertain" : "failed",
        sending ? "NOTIFICATION_DELIVERY_UNCERTAIN" : "NOTIFICATION_REJECTED",
      );
    }
  }
  async verify(config: NotificationConfig, signal: AbortSignal): Promise<void> {
    if (config.kind === "slack") {
      const auth = await this.request(config, "auth.test", {}, signal);
      const channel = await this.request(
        config,
        "conversations.info",
        { channel: config.destination },
        signal,
      );
      const parsed = z
        .object({
          id: z.string(),
          is_member: z.literal(true),
          is_archived: z.literal(false),
        })
        .safeParse(channel.channel);
      if (
        typeof auth.bot_id !== "string" ||
        !parsed.success ||
        parsed.data.id !== config.destination
      )
        throw new NotificationError("failed", "NOTIFICATION_REJECTED");
    } else {
      const me = await this.request(config, "getMe", {}, signal);
      const bot = z
        .object({ id: z.number().int(), is_bot: z.literal(true) })
        .safeParse(me.result);
      const chat = await this.request(
        config,
        "getChat",
        { chat_id: config.destination },
        signal,
      );
      const parsed = z
        .object({
          id: z.number().int(),
          type: z.enum(["private", "group", "supergroup", "channel"]),
          permissions: z
            .object({ can_send_messages: z.boolean().optional() })
            .optional(),
        })
        .safeParse(chat.result);
      if (
        !bot.success ||
        !parsed.success ||
        String(parsed.data.id) !== config.destination
      )
        throw new NotificationError("failed", "NOTIFICATION_REJECTED");
      if (parsed.data.type !== "private") {
        const member = await this.request(
          config,
          "getChatMember",
          { chat_id: config.destination, user_id: bot.data.id },
          signal,
        );
        const decoded = z
          .object({
            status: z.string(),
            can_post_messages: z.boolean().optional(),
            can_send_messages: z.boolean().optional(),
          })
          .safeParse(member.result);
        if (
          !decoded.success ||
          ["left", "kicked"].includes(decoded.data.status) ||
          (parsed.data.type === "channel" &&
            decoded.data.can_post_messages !== true) ||
          (decoded.data.status === "restricted" &&
            decoded.data.can_send_messages !== true) ||
          (decoded.data.status === "member" &&
            parsed.data.permissions?.can_send_messages === false)
        )
          throw new NotificationError("failed", "NOTIFICATION_REJECTED");
      }
    }
  }
  async send(
    config: NotificationConfig,
    message: string,
    signal: AbortSignal,
  ): Promise<{ messageId: string }> {
    const body =
      config.kind === "slack"
        ? {
            channel: config.destination,
            text: message
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;"),
            mrkdwn: false,
            parse: "none",
            unfurl_links: false,
            unfurl_media: false,
          }
        : {
            chat_id: config.destination,
            text: message,
            link_preview_options: { is_disabled: true },
          };
    const response = await this.request(
      config,
      config.kind === "slack" ? "chat.postMessage" : "sendMessage",
      body,
      signal,
      true,
    );
    const parsed =
      config.kind === "slack"
        ? z.string().min(1).safeParse(response.ts)
        : z.object({ message_id: z.number().int() }).safeParse(response.result);
    if (!parsed.success)
      throw new NotificationError(
        "uncertain",
        "NOTIFICATION_DELIVERY_UNCERTAIN",
      );
    return {
      messageId:
        typeof parsed.data === "string"
          ? parsed.data
          : String(parsed.data.message_id),
    };
  }
}
