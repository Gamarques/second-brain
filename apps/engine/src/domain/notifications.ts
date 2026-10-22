import type { BrainAccessContext, ClaimedAutomationJob } from "../domain.js";
export const deliveryChannelKinds = ["slack", "telegram"] as const;
export type DeliveryChannelKind = (typeof deliveryChannelKinds)[number];
export interface NotificationConfig {
  readonly kind: DeliveryChannelKind;
  readonly token: string;
  readonly destination: string;
}
export interface NotificationProvider {
  verify(config: NotificationConfig, signal: AbortSignal): Promise<void>;
  send(
    config: NotificationConfig,
    message: string,
    signal: AbortSignal,
  ): Promise<{ messageId: string }>;
}
export interface NotificationCipher {
  encrypt(id: string, config: NotificationConfig): string;
  decrypt(id: string, envelope: string): NotificationConfig;
}
export class NotificationError extends Error {
  readonly code: string;
  constructor(
    readonly outcome: "failed" | "retry" | "uncertain",
    code:
      | "NOTIFICATION_CONFIGURATION_UNAVAILABLE"
      | "NOTIFICATION_REJECTED"
      | "NOTIFICATION_RATE_LIMITED"
      | "NOTIFICATION_DELIVERY_UNCERTAIN"
      | "NOTIFICATION_CONFLICT",
    readonly retryAfterSeconds = 30,
  ) {
    super(code);
    this.name = "NotificationError";
    this.code = code;
  }
}
export interface NotificationChannel {
  readonly id: string;
  readonly kind: DeliveryChannelKind;
  readonly name: string;
  readonly destination: string;
  readonly enabled: boolean;
  readonly verifiedAt: string | null;
  readonly revision: number;
}
export interface SaveNotificationChannel {
  readonly id: string;
  readonly kind: DeliveryChannelKind;
  readonly name: string;
  readonly destination: string;
  readonly token?: string | undefined;
  readonly enabled: boolean;
  readonly expectedRevision: number;
}
export interface NotificationDelivery {
  readonly id: string;
  readonly reminderId: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly kind: DeliveryChannelKind;
  readonly message: string;
  readonly remindAt: string;
  readonly status:
    | "pending"
    | "running"
    | "delivered"
    | "retry_wait"
    | "failed"
    | "canceled"
    | "uncertain";
  readonly deliveredAt: string | null;
  readonly errorCode: string | null;
  readonly attemptCount: number;
  readonly createdAt: string;
}
export interface NotificationAdminStore {
  channels(
    access: BrainAccessContext,
    signal: AbortSignal,
  ): Promise<{
    channels: readonly NotificationChannel[];
    encryptionAvailable: boolean;
  }>;
  saveChannel(
    access: BrainAccessContext,
    input: SaveNotificationChannel,
    signal: AbortSignal,
  ): Promise<NotificationChannel>;
  deliveries(
    access: BrainAccessContext,
    input: { cursor?: string | null | undefined; limit: number },
    signal: AbortSignal,
  ): Promise<{
    deliveries: readonly NotificationDelivery[];
    nextCursor: string | null;
  }>;
}
export interface ReminderDispatchStore {
  materialize(now: Date, signal: AbortSignal): Promise<void>;
  prepare(
    claim: ClaimedAutomationJob,
    signal: AbortSignal,
  ): Promise<{
    deliveryId: string;
    config: NotificationConfig;
    message: string;
  } | null>;
  finish(
    claim: ClaimedAutomationJob,
    input: {
      status: "delivered" | "failed" | "uncertain" | "retry_wait";
      messageId?: string;
      errorCode?: string;
    },
    signal: AbortSignal,
  ): Promise<boolean>;
}
