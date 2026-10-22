import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Check, Clock, Plus, Settings2 } from "lucide-react";
import { useRef, useState } from "react";

import { EmptyState, ErrorState, LoadingState, PageSkeleton } from "../components/async-state";
import { ChannelMark } from "../components/brand-marks";
import { EmptyRemindersIllustration } from "../components/illustrations/empty-reminders";
import { ListCard, ListRow, Meta, MetaItem, Page, PageHeader, RowActions, Section } from "../components/page";
import { Alert } from "../components/ui/alert";
import { Badge, type BadgeTone } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ButtonLink } from "../components/ui/button-link";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { ConfirmDialog, Dialog } from "../components/ui/dialog";
import { Disclosure } from "../components/ui/disclosure";
import { Checkbox, Field, Input, Select, Textarea } from "../components/ui/field";
import { SwitchRow } from "../components/ui/switch";
import { api } from "../lib/api";
import { useLocale, useTranslation } from "../lib/i18n";
import type { DeliveryItem, NotificationChannel, ReminderItem } from "../lib/notification-types";
import { cn, formatDate, formatRelativeTime, toLocalDateTimeInput } from "../lib/utils";

/** Times people actually mean when they say "remind me": soon, tomorrow morning, Monday morning, next week. */
const quickTimes = [
  { key: "reminders.preset.inOneHour", at: (now: Date) => new Date(now.getTime() + 60 * 60_000) },
  { key: "reminders.preset.tomorrowMorning", at: (now: Date) => morningOf(now, 1) },
  { key: "reminders.preset.nextMonday", at: (now: Date) => morningOf(now, ((8 - now.getDay()) % 7) || 7) },
  { key: "reminders.preset.nextWeek", at: (now: Date) => new Date(now.getTime() + 7 * 24 * 60 * 60_000) },
] as const;

function morningOf(now: Date, daysAhead: number): Date {
  const date = new Date(now);
  date.setDate(date.getDate() + daysAhead);
  date.setHours(9, 0, 0, 0);
  return date;
}

function deliveryTone(status: DeliveryItem["status"]): BadgeTone {
  switch (status) {
    case "delivered":
      return "success";
    case "failed":
    case "canceled":
      return "danger";
    case "uncertain":
    case "retry_wait":
      return "warning";
    case "running":
      return "info";
    default:
      return "neutral";
  }
}

export function RemindersPage() {
  const t = useTranslation();
  const { locale } = useLocale();
  const client = useQueryClient();
  const [channel, setChannel] = useState<NotificationChannel | "new" | null>(null);
  const [reminder, setReminder] = useState<ReminderItem | "new" | null>(null);
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [confirmEnable, setConfirmEnable] = useState(false);
  const identity = useQuery({ queryKey: ["me"], queryFn: ({ signal }) => api.me(signal) });
  const channels = useQuery({ queryKey: ["notification-channels"], queryFn: ({ signal }) => api.notificationChannels(signal) });
  const settings = useQuery({ queryKey: ["automation-settings"], queryFn: ({ signal }) => api.automationSettings(signal) });
  const reminders = useInfiniteQuery({
    queryKey: ["reminders", includeCompleted],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api.reminders({ includeCompleted, cursor: pageParam, limit: 20 }, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 30_000,
  });
  const deliveries = useInfiniteQuery({
    queryKey: ["notification-deliveries"],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api.notificationDeliveries({ cursor: pageParam, limit: 20 }, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 15_000,
  });
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["reminders"] }),
      client.invalidateQueries({ queryKey: ["briefing"] }),
      client.invalidateQueries({ queryKey: ["notification-deliveries"] }),
    ]);
  };
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api.updateAutomationSettings({
        reminderDeliveryEnabled: enabled,
        expectedRevision: settings.data!.revision,
        idempotencyKey: `reminder-delivery:${settings.data!.revision}:${enabled}`,
      }),
    onSuccess: async () => {
      setConfirmEnable(false);
      await settings.refetch();
    },
  });
  const complete = useMutation({
    mutationFn: (item: ReminderItem) =>
      api.updateReminder({
        id: item.id,
        expectedVersion: item.version,
        completed: true,
        idempotencyKey: `reminder-complete:${item.id}:${item.version}`,
      }),
    onSuccess: refresh,
  });
  if (channels.isPending || settings.isPending || reminders.isPending) return <PageSkeleton cards={3} />;
  if (channels.isError || settings.isError || reminders.isError) {
    return (
      <ErrorState
        error={channels.error ?? settings.error ?? reminders.error}
        retry={() => {
          void channels.refetch();
          void settings.refetch();
          void reminders.refetch();
        }}
      />
    );
  }
  const owner = identity.data?.role === "owner";
  const enabled = settings.data.reminderDeliveryEnabled;
  const hasEnabledChannel = channels.data.channels.some((item) => item.enabled);
  const reminderItems = reminders.data.pages.flatMap((page) => page.reminders);
  const deliveryItems = deliveries.data?.pages.flatMap((page) => page.deliveries) ?? [];

  const showHistory = deliveries.isPending || deliveries.isError || deliveryItems.length > 0;

  return (
    <Page>
      <PageHeader
        actions={
          <Button onClick={() => setReminder("new")}>
            <Plus aria-hidden="true" />
            {t("reminders.create")}
          </Button>
        }
        description={t("reminders.description")}
        title={t("reminders.title")}
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start">
        <div className="grid gap-6">
          <Section
            actions={<Checkbox checked={includeCompleted} label={t("reminders.includeCompleted")} onChange={(event) => setIncludeCompleted(event.target.checked)} variant="inline" />}
            title={t("reminders.pending")}
          >
            {complete.isError && <ErrorState error={complete.error} />}
            {reminderItems.length === 0 ? (
              <EmptyState
                action={<Button onClick={() => setReminder("new")} size="sm"><Plus aria-hidden="true" />{t("reminders.create")}</Button>}
                description={t("reminders.empty")}
                example={t("reminders.example")}
                illustration={<EmptyRemindersIllustration />}
                title={t("reminders.emptyTitle")}
              />
            ) : (
              <ListCard>
                {reminderItems.map((item) => {
                  const done = item.completedAt !== null;
                  const overdue = !done && new Date(item.remindAt).getTime() < Date.now();
                  return (
                    <ListRow className="sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center" key={item.id}>
                      <div className="grid min-w-0 gap-1">
                        <p className={cn("max-w-prose whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground", done && "text-muted-foreground line-through decoration-muted-foreground/40")}>{item.message}</p>
                        <Meta>
                          <MetaItem icon={Clock}>{formatDate(item.remindAt, locale)}</MetaItem>
                          <MetaItem tone={overdue ? "warning" : "neutral"}>{formatRelativeTime(item.remindAt, Date.now(), locale)}</MetaItem>
                          {overdue && <Badge dot tone="warning">{t("reminders.overdue")}</Badge>}
                          {done && <MetaItem icon={Check} tone="success">{t("reminders.completed")}</MetaItem>}
                        </Meta>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {!done && (
                          <Button disabled={complete.isPending} onClick={() => complete.mutate(item)} size="sm" variant="outline">
                            <Check aria-hidden="true" />
                            {t("reminders.complete")}
                          </Button>
                        )}
                        <Button onClick={() => setReminder(item)} size="sm" variant="ghost">
                          <Clock aria-hidden="true" />
                          {t(done ? "reminders.reschedule" : "reminders.snooze")}
                        </Button>
                      </div>
                    </ListRow>
                  );
                })}
              </ListCard>
            )}
            {reminders.hasNextPage && (
              <div className="flex justify-center">
                <Button disabled={reminders.isFetchingNextPage} loading={reminders.isFetchingNextPage} onClick={() => void reminders.fetchNextPage()} size="sm" variant="outline">
                  {t("reminders.more")}
                </Button>
              </div>
            )}
          </Section>

          {showHistory && (
            <Section
              actions={
                <ButtonLink size="sm" to="/automation/jobs" variant="ghost">
                  {t("reminders.jobs")}
                </ButtonLink>
              }
              title={t("reminders.history")}
            >
              {deliveries.isError && <ErrorState error={deliveries.error} retry={() => void deliveries.refetch()} />}
              {deliveries.isPending ? (
                <LoadingState className="min-h-24" />
              ) : (
                deliveryItems.length > 0 && (
                  <ListCard>
                    {deliveryItems.map((item) => {
                      const tone = deliveryTone(item.status);
                      const hint = item.status === "uncertain" ? t("reminders.uncertainHint") : item.status === "canceled" ? t("reminders.canceledHint") : item.status === "failed" ? t("reminders.failedHint") : null;
                      return (
                        <ListRow key={item.id}>
                          <p className="max-w-prose whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">{item.message}</p>
                          <Meta>
                            <MetaItem>
                              <ChannelMark kind={item.kind} />
                              {item.channelName}
                            </MetaItem>
                            <MetaItem>{formatDate(item.deliveredAt ?? item.createdAt, locale)}</MetaItem>
                            <MetaItem tone={tone}>{t(`reminders.delivery.${item.status}`)}</MetaItem>
                          </Meta>
                          {hint && <p className={cn("max-w-prose text-xs leading-relaxed", tone === "danger" ? "text-danger" : "text-warning")}>{hint}</p>}
                        </ListRow>
                      );
                    })}
                  </ListCard>
                )
              )}
              {deliveries.hasNextPage && (
                <div className="flex justify-center">
                  <Button disabled={deliveries.isFetchingNextPage} loading={deliveries.isFetchingNextPage} onClick={() => void deliveries.fetchNextPage()} size="sm" variant="outline">
                    {t("reminders.more")}
                  </Button>
                </div>
              )}
            </Section>
          )}
        </div>

        <section aria-labelledby="reminders-delivery-title" className="xl:sticky xl:top-[4.75rem]">
          <Card>
            <CardHeader>
              <CardTitle id="reminders-delivery-title">{t("reminders.channels")}</CardTitle>
            </CardHeader>
            <CardContent className="grid divide-y divide-border/60">
              <SwitchRow
                checked={enabled}
                className="pt-0"
                description={t(enabled ? "reminders.deliveryOn" : "reminders.deliveryOff")}
                disabled={toggle.isPending || (!enabled && !hasEnabledChannel)}
                label={t("reminders.deliveryToggle")}
                onCheckedChange={(next) => (next ? setConfirmEnable(true) : toggle.mutate(false))}
                variant="plain"
              />
              {toggle.isError && <div className="py-3"><ErrorState error={toggle.error} /></div>}
              {channels.data.channels.length === 0 ? (
                <p className="py-3 text-xs leading-relaxed text-muted-foreground">{t("reminders.noChannels")}</p>
              ) : (
                <ul className="divide-y divide-border/60">
                  {channels.data.channels.map((item) => (
                    <li className="group/row relative grid gap-1 py-3" key={item.id}>
                      <div className="flex items-center gap-2">
                        <ChannelMark className="text-muted-foreground" kind={item.kind} />
                        <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{item.name}</p>
                        {owner && (
                          <RowActions className="-my-1">
                            <Button aria-label={t("reminders.configure")} onClick={() => setChannel(item)} size="icon-sm" title={t("reminders.configure")} variant="ghost">
                              <Settings2 aria-hidden="true" />
                            </Button>
                          </RowActions>
                        )}
                      </div>
                      <Meta className="pl-6">
                        <MetaItem className="font-mono">{item.destination}</MetaItem>
                        {item.verifiedAt && <MetaItem>{t("reminders.verified", { date: formatDate(item.verifiedAt, locale) })}</MetaItem>}
                        {!item.enabled && <MetaItem>{t("reminders.channelDisabled")}</MetaItem>}
                      </Meta>
                    </li>
                  ))}
                </ul>
              )}
              <div className="grid gap-3 pt-3">
                {owner ? (
                  <Button
                    className="w-full"
                    disabled={channels.data.channels.length >= 20 || !channels.data.encryptionAvailable}
                    onClick={() => setChannel("new")}
                    size="sm"
                    variant="outline"
                  >
                    <Plus aria-hidden="true" />
                    {t("reminders.addChannel")}
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">{t("reminders.ownerOnly")}</p>
                )}
                <Disclosure size="sm" summary={t("common.howThisWorks")}>
                  <p className="text-xs leading-relaxed text-muted-foreground">{t("reminders.howDelivery.body")}</p>
                </Disclosure>
              </div>
            </CardContent>
          </Card>
        </section>
      </div>

      {channel && (
        <ChannelDialog
          channel={channel === "new" ? null : channel}
          close={() => setChannel(null)}
          key={channel === "new" ? "new" : channel.id}
          saved={async () => {
            await channels.refetch();
            setChannel(null);
          }}
        />
      )}
      {reminder && (
        <ReminderDialog
          close={() => setReminder(null)}
          item={reminder === "new" ? null : reminder}
          key={reminder === "new" ? "new" : reminder.id}
          saved={async () => {
            await refresh();
            setReminder(null);
          }}
        />
      )}
      <ConfirmDialog
        confirmLabel={t("reminders.confirmEnable")}
        description={t("reminders.enableWarning")}
        onCancel={() => setConfirmEnable(false)}
        onConfirm={() => toggle.mutate(true)}
        open={confirmEnable}
        pending={toggle.isPending}
        title={t("reminders.enable")}
      >
        {toggle.isError ? <ErrorState error={toggle.error} /> : <p className="text-sm leading-relaxed text-muted-foreground">{t("reminders.channelConsent")}</p>}
      </ConfirmDialog>
    </Page>
  );
}

function ChannelDialog({ channel, close, saved }: { channel: NotificationChannel | null; close: () => void; saved: () => Promise<void> }) {
  const t = useTranslation();
  const id = useRef(channel?.id ?? crypto.randomUUID());
  const [kind, setKind] = useState<"slack" | "telegram">(channel?.kind ?? "telegram");
  const [name, setName] = useState(channel?.name ?? "");
  const [destination, setDestination] = useState(channel?.destination ?? "");
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(channel?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  return (
    <Dialog
      description={t("reminders.channelConsent")}
      footer={
        <>
          <Button disabled={saving} onClick={close} variant="ghost">{t("common.cancel")}</Button>
          <Button disabled={saving} form="notification-channel" loading={saving} type="submit">
            {t(saving ? "reminders.verifying" : "reminders.saveChannel")}
          </Button>
        </>
      }
      onClose={() => {
        if (!saving) close();
      }}
      open
      title={channel ? t("reminders.configure") : t("reminders.addChannel")}
    >
      <form
        className="grid gap-4"
        id="notification-channel"
        onSubmit={async (event) => {
          event.preventDefault();
          if (saving) return;
          setSaving(true);
          setError(false);
          try {
            await api.saveNotificationChannel({
              id: id.current,
              kind,
              name,
              destination,
              ...(token.trim() ? { token: token.trim() } : {}),
              enabled,
              expectedRevision: channel?.revision ?? 0,
            });
            setToken("");
            await saved();
          } catch {
            setError(true);
          } finally {
            setSaving(false);
          }
        }}
      >
        <Field hint={t(kind === "slack" ? "reminders.slackHelp" : "reminders.telegramHelp")} htmlFor="notification-kind" label={t("reminders.channelKind")}>
          <Select
            disabled={saving || !!channel}
            id="notification-kind"
            onChange={(event) => {
              setKind(event.target.value as typeof kind);
              setToken("");
              setDestination("");
            }}
            value={kind}
          >
            <option value="telegram">{t("reminders.kind.telegram")}</option>
            <option value="slack">{t("reminders.kind.slack")}</option>
          </Select>
        </Field>
        <Field htmlFor="notification-name" label={t("reminders.channelName")}>
          <Input disabled={saving} id="notification-name" maxLength={200} onChange={(event) => setName(event.target.value)} required value={name} />
        </Field>
        <Field htmlFor="notification-destination" label={t(kind === "slack" ? "reminders.slackDestination" : "reminders.telegramDestination")}>
          <Input autoComplete="off" className="font-mono" disabled={saving} id="notification-destination" maxLength={100} onChange={(event) => setDestination(event.target.value)} required value={destination} />
        </Field>
        <Field hint={t(channel ? "reminders.preserveToken" : "reminders.tokenHint")} htmlFor="notification-token" label={t("reminders.token")}>
          <Input autoComplete="new-password" disabled={saving} id="notification-token" maxLength={500} onChange={(event) => setToken(event.target.value)} required={!channel} type="password" value={token} />
        </Field>
        <SwitchRow checked={enabled} disabled={saving} label={t("reminders.channelEnabled")} onCheckedChange={setEnabled} />
        {error && <Alert title={t("reminders.channelError")} tone="danger" />}
      </form>
    </Dialog>
  );
}

function ReminderDialog({ item, close, saved }: { item: ReminderItem | null; close: () => void; saved: () => Promise<void> }) {
  const t = useTranslation();
  const [message, setMessage] = useState("");
  const [time, setTime] = useState("");
  const key = useRef(crypto.randomUUID());
  const [invalid, setInvalid] = useState(false);
  const action = useMutation({
    mutationFn: () =>
      item
        ? api.updateReminder({
            id: item.id,
            expectedVersion: item.version,
            remindAt: new Date(time).toISOString(),
            completed: false,
            idempotencyKey: `reminder-snooze:${key.current}`,
          })
        : api.createReminder({
            message,
            remindAt: new Date(time).toISOString(),
            idempotencyKey: `reminder-create:${key.current}`,
          }),
    onSuccess: saved,
  });
  const changed = () => {
    key.current = crypto.randomUUID();
    setInvalid(false);
    action.reset();
  };
  return (
    <Dialog
      description={t("reminders.timeHelp")}
      footer={
        <>
          <Button disabled={action.isPending} onClick={close} variant="ghost">{t("common.cancel")}</Button>
          <Button disabled={action.isPending} form="reminder-form" loading={action.isPending} type="submit">
            {t(item ? "reminders.confirmSnooze" : "reminders.confirmCreate")}
          </Button>
        </>
      }
      onClose={() => {
        if (!action.isPending) close();
      }}
      open
      title={t(item ? "reminders.snooze" : "reminders.create")}
    >
      <form
        className="grid gap-4"
        id="reminder-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!Number.isFinite(Date.parse(time)) || Date.parse(time) <= Date.now()) {
            setInvalid(true);
            return;
          }
          action.mutate();
        }}
      >
        {item ? (
          <p className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 px-3.5 py-3 text-sm leading-relaxed text-foreground">{item.message}</p>
        ) : (
          <Field htmlFor="reminder-message" label={t("reminders.message")}>
            <Textarea
              disabled={action.isPending}
              id="reminder-message"
              maxLength={2000}
              onChange={(event) => {
                setMessage(event.target.value);
                changed();
              }}
              required
              value={message}
            />
          </Field>
        )}
        <div className="grid gap-1.5">
          <p className="text-xs font-medium text-muted-foreground">{t("reminders.quickTimes")}</p>
          <div className="flex flex-wrap gap-1.5">
            {quickTimes.map((preset) => (
              <Button
                disabled={action.isPending}
                key={preset.key}
                onClick={() => {
                  setTime(toLocalDateTimeInput(preset.at(new Date()).toISOString()));
                  changed();
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                {t(preset.key)}
              </Button>
            ))}
          </div>
        </div>
        <Field error={invalid ? t("reminders.futureTime") : null} htmlFor="reminder-time" label={t(item ? "reminders.newTime" : "reminders.time")}>
          <Input
            disabled={action.isPending}
            id="reminder-time"
            onChange={(event) => {
              setTime(event.target.value);
              changed();
            }}
            required
            type="datetime-local"
            value={time}
          />
        </Field>
        {action.isError && <ErrorState error={action.error} />}
      </form>
    </Dialog>
  );
}
