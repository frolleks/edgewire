import type { UserSummary } from "@discord/types";
import { useQuery } from "@tanstack/react-query";
import type { ChangeEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Paperclip } from "lucide-react";
import type { ComposerAttachment } from "@/app/types";
import MentionToken from "@/components/chat/mention-token";
import { formatBytes, getDisplayInitial } from "@/components/utils/format";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type ComposerProps = {
  value: string;
  onValueChange: (value: string) => void;
  canSendInActiveChannel: boolean;
  routeMode: "dm" | "guild";
  guildId?: string | null;
  currentUserId?: string | null;
  dmMentionUser?: UserSummary | null;
  dmUsername?: string;
  channelName?: string | null;
  attachments: ComposerAttachment[];
  isSendingMessage: boolean;
  isSendMutationPending: boolean;
  onAttachmentInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onRemoveAttachment: (localId: string) => void;
  onSend: (serializedValue?: string) => void;
  onTriggerTyping: () => void;
};

type MentionTrigger = {
  query: string;
  start: number;
  end: number;
};

const USER_MENTION_TOKEN_REGEX = /<@!?([^\s>]+)>/g;
const EVERYONE_MENTION_TOKEN_REGEX = /\B@(?:everyone|here)\b/g;
const MENTION_TRIGGER_REGEX = /(?:^|\s)@([a-z0-9_.-]*)$/i;
const COMPOSER_PREVIEW_MENTION_CLASS = "rounded-sm px-0 py-0 font-normal";

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const serializeComposerMentions = (
  value: string,
  usersById: Record<string, UserSummary>,
): string => {
  const candidates = Object.values(usersById)
    .map(user => ({ id: user.id, label: `@${user.display_name}` }))
    .sort((left, right) => right.label.length - left.label.length);

  let serialized = value;
  for (const candidate of candidates) {
    const pattern = new RegExp(
      `(^|\\s)${escapeRegex(candidate.label)}(?=$|[\\s.,!?;:])`,
      "g",
    );
    serialized = serialized.replace(pattern, `$1<@${candidate.id}>`);
  }

  return serialized;
};

const findMentionTrigger = (value: string, cursor: number): MentionTrigger | null => {
  const beforeCursor = value.slice(0, cursor);
  const match = beforeCursor.match(MENTION_TRIGGER_REGEX);
  if (!match) {
    return null;
  }

  const query = match[1] ?? "";
  const start = cursor - query.length - 1;
  if (start < 0) {
    return null;
  }

  // Ignore rich-token like "<@123>" when user is editing the token itself.
  if (start > 0 && beforeCursor[start - 1] === "<") {
    return null;
  }

  return {
    query,
    start,
    end: cursor,
  };
};

export function Composer({
  value,
  onValueChange,
  canSendInActiveChannel,
  routeMode,
  guildId,
  currentUserId,
  dmMentionUser,
  dmUsername,
  channelName,
  attachments,
  isSendingMessage,
  isSendMutationPending,
  onAttachmentInputChange,
  onRemoveAttachment,
  onSend,
  onTriggerTyping,
}: ComposerProps) {
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const pendingCaretPositionRef = useRef<number | null>(null);
  const [cursorPosition, setCursorPosition] = useState(value.length);
  const [debouncedMentionQuery, setDebouncedMentionQuery] = useState("");
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const [dismissedMentionContext, setDismissedMentionContext] = useState<string | null>(null);
  const [knownMentionUsersById, setKnownMentionUsersById] = useState<Record<string, UserSummary>>({});
  const isSendDisabled =
    isSendingMessage || isSendMutationPending || !canSendInActiveChannel;
  const maxTextareaHeight = 144;

  const autosize = (textarea: HTMLTextAreaElement): void => {
    textarea.style.height = "0px";
    const nextHeight = Math.min(textarea.scrollHeight, maxTextareaHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > maxTextareaHeight ? "auto" : "hidden";
  };

  useEffect(() => {
    if (textareaRef.current) {
      autosize(textareaRef.current);
    }
  }, [value]);

  useEffect(() => {
    if (!textareaRef.current || pendingCaretPositionRef.current === null) {
      return;
    }

    const nextPosition = pendingCaretPositionRef.current;
    textareaRef.current.focus();
    textareaRef.current.setSelectionRange(nextPosition, nextPosition);
    pendingCaretPositionRef.current = null;
  }, [value]);

  const mentionTrigger = useMemo(
    () => findMentionTrigger(value, Math.max(0, Math.min(cursorPosition, value.length))),
    [cursorPosition, value],
  );

  const mentionContextKey = mentionTrigger ? `${mentionTrigger.start}:${mentionTrigger.query}` : null;

  useEffect(() => {
    if (!mentionTrigger) {
      setDebouncedMentionQuery("");
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setDebouncedMentionQuery(mentionTrigger.query.trim());
    }, 120);

    return () => window.clearTimeout(timeoutId);
  }, [mentionTrigger?.query, mentionTrigger]);

  useEffect(() => {
    setActiveSuggestionIndex(0);
  }, [mentionContextKey]);

  const guildMentionQuery = useQuery({
    queryKey: ["composer-mention-users", guildId ?? "none", debouncedMentionQuery],
    queryFn: () =>
      api.listGuildMembers(guildId!, {
        limit: 8,
        query: debouncedMentionQuery || undefined,
      }),
    enabled: routeMode === "guild" && Boolean(guildId) && Boolean(mentionTrigger),
    staleTime: 15_000,
  });
  const guildMentionMembers = guildMentionQuery.data?.members;

  useEffect(() => {
    if (routeMode === "dm") {
      if (!dmMentionUser) {
        return;
      }
      setKnownMentionUsersById(previous => ({
        ...previous,
        [dmMentionUser.id]: dmMentionUser,
      }));
      return;
    }

    const nextEntries = (guildMentionMembers ?? []).map(member => member.user);
    if (nextEntries.length === 0) {
      return;
    }

    setKnownMentionUsersById(previous => {
      const next = { ...previous };
      for (const user of nextEntries) {
        next[user.id] = user;
      }
      return next;
    });
  }, [dmMentionUser, guildMentionMembers, routeMode]);

  const mentionSuggestions = useMemo(() => {
    if (!mentionTrigger) {
      return [] as UserSummary[];
    }

    const query = mentionTrigger.query.trim().toLowerCase();
    const matchesQuery = (user: UserSummary): boolean => {
      if (!query) {
        return true;
      }
      return (
        user.display_name.toLowerCase().startsWith(query) ||
        user.username.toLowerCase().startsWith(query)
      );
    };

    if (routeMode === "dm") {
      if (!dmMentionUser || !matchesQuery(dmMentionUser)) {
        return [] as UserSummary[];
      }
      return [dmMentionUser];
    }

    const deduped = new Map<string, UserSummary>();
    for (const member of guildMentionMembers ?? []) {
      if (member.user.id === currentUserId) {
        continue;
      }
      if (!matchesQuery(member.user)) {
        continue;
      }
      deduped.set(member.user.id, member.user);
    }

    return [...deduped.values()].slice(0, 8);
  }, [currentUserId, dmMentionUser, guildMentionMembers, mentionTrigger, routeMode]);

  const mentionMenuOpen =
    Boolean(mentionTrigger) &&
    mentionSuggestions.length > 0 &&
    dismissedMentionContext !== mentionContextKey;

  useEffect(() => {
    if (!mentionMenuOpen) {
      return;
    }

    setActiveSuggestionIndex(previous => {
      if (previous < mentionSuggestions.length) {
        return previous;
      }
      return 0;
    });
  }, [mentionMenuOpen, mentionSuggestions.length]);

  const applyMentionSuggestion = (user: UserSummary): void => {
    if (!mentionTrigger) {
      return;
    }

    const before = value.slice(0, mentionTrigger.start);
    const after = value.slice(mentionTrigger.end);
    const needsTrailingSpace = after.length === 0 || !/^\s/.test(after);
    const insertion = `@${user.display_name}${needsTrailingSpace ? " " : ""}`;
    const nextValue = `${before}${insertion}${after}`;
    const nextCursor = before.length + insertion.length;

    onValueChange(nextValue);
    pendingCaretPositionRef.current = nextCursor;
    setCursorPosition(nextCursor);
    setKnownMentionUsersById(previous => ({
      ...previous,
      [user.id]: user,
    }));
    setDismissedMentionContext(null);
    onTriggerTyping();
  };

  const knownUserMentionLabels = useMemo(
    () =>
      Object.values(knownMentionUsersById)
        .map(user => ({ label: `@${user.display_name}`, user }))
        .sort((left, right) => right.label.length - left.label.length),
    [knownMentionUsersById],
  );

  const knownUserByMentionLabel = useMemo(
    () => new Map(knownUserMentionLabels.map(entry => [entry.label, entry.user])),
    [knownUserMentionLabels],
  );

  const renderedComposerContent = useMemo(() => {
    if (!value) {
      return null;
    }

    const nodes: React.ReactNode[] = [];
    const knownMentionPattern = knownUserMentionLabels
      .map(entry => escapeRegex(entry.label))
      .join("|");
    const tokenRegex = new RegExp(
      `<@!?[^\\s>]+>|\\B@(?:everyone|here)\\b${knownMentionPattern ? `|${knownMentionPattern}` : ""}`,
      "g",
    );
    let cursor = 0;

    for (const match of value.matchAll(tokenRegex)) {
      const token = match[0];
      const index = match.index ?? 0;
      if (index > cursor) {
        nodes.push(value.slice(cursor, index));
      }

      const userMatch = token.match(/^<@!?([^\s>]+)>$/);
      if (userMatch) {
        const userId = userMatch[1];
        const user = userId ? knownMentionUsersById[userId] : undefined;
        const fallbackLabel = userId ? `@user-${userId.slice(-4)}` : "@unknown";
        nodes.push(
          <MentionToken
            key={`composer-user-${index}-${userId ?? "unknown"}`}
            label={user ? `@${user.display_name}` : fallbackLabel}
            className={COMPOSER_PREVIEW_MENTION_CLASS}
          />,
        );
        cursor = index + token.length;
        continue;
      }

      const knownUser = knownUserByMentionLabel.get(token);
      if (knownUser) {
        nodes.push(
          <MentionToken
            key={`composer-user-label-${index}-${knownUser.id}`}
            label={token}
            className={COMPOSER_PREVIEW_MENTION_CLASS}
          />,
        );
        cursor = index + token.length;
        continue;
      }

      nodes.push(
        <MentionToken
          key={`composer-everyone-${index}`}
          label={token}
          className={`${COMPOSER_PREVIEW_MENTION_CLASS} bg-primary/15 text-primary`}
        />,
      );
      cursor = index + token.length;
    }

    if (cursor < value.length) {
      nodes.push(value.slice(cursor));
    }

    return nodes;
  }, [knownUserMentionLabels, knownUserByMentionLabel, knownMentionUsersById, value]);

  const serializedComposerValue = useMemo(
    () => serializeComposerMentions(value, knownMentionUsersById),
    [knownMentionUsersById, value],
  );

  return (
    <footer className="shrink-0 p-4 bg-card">
      <div className="relative">
        {mentionMenuOpen ? (
          <div className="absolute bottom-full left-0 right-0 z-20 mb-2 rounded-md border bg-popover shadow-md">
            <p className="px-2 py-1 text-[11px] uppercase tracking-wide text-muted-foreground">
              Mention Users
            </p>
            <div className="max-h-52 overflow-y-auto p-1">
              {mentionSuggestions.map((user, index) => {
                const active = index === activeSuggestionIndex;
                return (
                  <button
                    key={user.id}
                    type="button"
                    className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm ${
                      active ? "bg-accent" : "hover:bg-accent"
                    }`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      applyMentionSuggestion(user);
                    }}
                  >
                    <span className="grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-[10px] font-semibold uppercase">
                      {user.avatar_url ? (
                        <img
                          src={user.avatar_url}
                          alt={`${user.display_name} avatar`}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        getDisplayInitial(user.display_name)
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{user.display_name}</span>
                      <span className="block truncate text-xs text-muted-foreground">@{user.username}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {value ? (
          <div
            ref={previewRef}
            aria-hidden
            className="pointer-events-none absolute inset-px overflow-hidden whitespace-pre-wrap break-words pl-12 pr-12 py-2.5 text-base leading-5 md:text-sm"
          >
            <span className="text-foreground">{renderedComposerContent}</span>
          </div>
        ) : null}

        <Textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(event) => {
            onValueChange(event.target.value);
            onTriggerTyping();
            autosize(event.target);
            setCursorPosition(event.target.selectionStart ?? event.target.value.length);
            setDismissedMentionContext(null);
            if (previewRef.current) {
              previewRef.current.scrollTop = event.target.scrollTop;
              previewRef.current.scrollLeft = event.target.scrollLeft;
            }
          }}
          onSelect={(event) => {
            setCursorPosition(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
          }}
          onClick={(event) => {
            setCursorPosition(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
          }}
          onScroll={(event) => {
            if (!previewRef.current) {
              return;
            }
            previewRef.current.scrollTop = event.currentTarget.scrollTop;
            previewRef.current.scrollLeft = event.currentTarget.scrollLeft;
          }}
          disabled={!canSendInActiveChannel || isSendingMessage}
          onKeyDown={(event) => {
            if (mentionMenuOpen) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveSuggestionIndex((previous) => (previous + 1) % mentionSuggestions.length);
                return;
              }

              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveSuggestionIndex((previous) =>
                  previous === 0 ? mentionSuggestions.length - 1 : previous - 1,
                );
                return;
              }

              if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
                event.preventDefault();
                const selected = mentionSuggestions[activeSuggestionIndex];
                if (selected) {
                  applyMentionSuggestion(selected);
                }
                return;
              }

              if (event.key === "Escape") {
                event.preventDefault();
                setDismissedMentionContext(mentionContextKey);
                return;
              }
            }

            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend(serializedComposerValue);
            }
          }}
          placeholder={
            routeMode === "dm"
              ? `Message @${dmUsername ?? "user"}`
              : `Message #${channelName ?? "channel"}`
          }
          className={cn(
            "min-h-10 max-h-36 resize-none pl-12 pr-12 py-2.5 leading-5",
            value
              ? "bg-transparent text-transparent caret-foreground selection:bg-accent/40"
              : "",
          )}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => attachmentInputRef.current?.click()}
          disabled={isSendingMessage || !canSendInActiveChannel}
          aria-label="Attach"
          title="Attach"
          className="absolute bottom-1 left-1"
        >
          <Paperclip />
        </Button>
        <Button
          onClick={() => onSend(serializedComposerValue)}
          size="icon-sm"
          disabled={isSendDisabled}
          aria-label={
            isSendingMessage || isSendMutationPending ? "Sending..." : "Send"
          }
          title={
            isSendingMessage || isSendMutationPending ? "Sending..." : "Send"
          }
          className="absolute bottom-1 right-1"
        >
          <ArrowUp />
        </Button>
      </div>
      <input
        ref={attachmentInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={onAttachmentInputChange}
      />
      {!canSendInActiveChannel && routeMode === "guild" ? (
        <p className="mt-2 text-xs">
          You do not have permission to send messages in this server.
        </p>
      ) : null}
      {attachments.length > 0 ? (
        <div className="mt-3 space-y-2">
          {attachments.map((attachment) => (
            <div
              key={attachment.local_id}
              className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {attachment.filename}
                </p>
                <p className="text-xs">
                  {formatBytes(attachment.size)} · {attachment.status}
                  {attachment.error ? ` · ${attachment.error}` : ""}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onRemoveAttachment(attachment.local_id)}
                disabled={isSendingMessage || attachment.status === "uploading"}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </footer>
  );
}

export default Composer;
