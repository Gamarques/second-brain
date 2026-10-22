export interface NotificationChannel {
  id: string;
  kind: "slack" | "telegram";
  name: string;
  destination: string;
  enabled: boolean;
  verifiedAt: string | null;
  revision: number;
}
export interface ReminderItem {
  id: string;
  message: string;
  remindAt: string;
  completedAt: string | null;
  version: number;
}
export interface DeliveryItem {
  id: string;
  reminderId: string;
  channelId: string;
  channelName: string;
  kind: "slack" | "telegram";
  message: string;
  remindAt: string;
  status:
    | "pending"
    | "running"
    | "delivered"
    | "retry_wait"
    | "failed"
    | "canceled"
    | "uncertain";
  deliveredAt: string | null;
  errorCode: string | null;
  attemptCount: number;
  createdAt: string;
}
