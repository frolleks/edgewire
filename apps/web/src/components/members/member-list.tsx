import type { UserSummary } from "@discord/types";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, type GuildMemberSummary } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import MemberListSkeleton from "./member-list-skeleton";
import MemberRow from "./member-row";
import {
  buildRoleIndex,
  getMemberStatus,
  getTopRole,
  sortMembers,
  type MemberStatus,
} from "./member-utils";

type MemberListProps = {
  guildId: string;
  currentUserId: string;
  onOpenProfile: (user: UserSummary) => void;
  onStartDm: (userId: string) => void | Promise<void>;
  typingUserIds?: Iterable<string>;
};

type MemberListItem = {
  member: GuildMemberSummary;
  topRoleColor?: number | null;
};

const STATUS_ORDER: MemberStatus[] = ["online", "idle", "dnd", "offline"];

const STATUS_LABELS: Record<MemberStatus, string> = {
  online: "ONLINE",
  idle: "IDLE",
  dnd: "DO NOT DISTURB",
  offline: "OFFLINE",
};

export function MemberList({
  guildId,
  currentUserId,
  onOpenProfile,
  onStartDm,
  typingUserIds,
}: MemberListProps) {
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, 300);

    return () => window.clearTimeout(timeoutId);
  }, [searchInput]);

  useEffect(() => {
    setSearchInput("");
    setDebouncedSearch("");
  }, [guildId]);

  const membersQuery = useInfiniteQuery({
    queryKey: queryKeys.guildMembers(guildId, debouncedSearch),
    queryFn: ({ pageParam }) =>
      api.listGuildMembers(guildId, {
        limit: 100,
        after: pageParam || undefined,
        query: debouncedSearch || undefined,
      }),
    initialPageParam: "",
    getNextPageParam: (lastPage) => lastPage.next_after ?? undefined,
    enabled: Boolean(guildId),
  });

  const rolesQuery = useQuery({
    queryKey: queryKeys.guildRoles(guildId),
    queryFn: () => api.listGuildRoles(guildId),
    enabled: Boolean(guildId),
  });

  const typingSet = useMemo(() => {
    const next = new Set<string>();
    if (!typingUserIds) {
      return next;
    }

    for (const userId of typingUserIds) {
      next.add(userId);
    }
    return next;
  }, [typingUserIds]);

  const members = useMemo(() => {
    const seen = new Set<string>();
    const next: GuildMemberSummary[] = [];
    for (const page of membersQuery.data?.pages ?? []) {
      for (const member of page.members) {
        if (seen.has(member.user.id)) {
          continue;
        }
        seen.add(member.user.id);
        next.push(member);
      }
    }
    return next;
  }, [membersQuery.data]);

  const roleIndex = useMemo(
    () => buildRoleIndex(rolesQuery.data ?? []),
    [rolesQuery.data],
  );

  const groupedMembers = useMemo(() => {
    const grouped: Record<MemberStatus, MemberListItem[]> = {
      online: [],
      idle: [],
      dnd: [],
      offline: [],
    };

    for (const member of sortMembers(members, roleIndex)) {
      let status = getMemberStatus(member);
      if (status === "offline" && typingSet.has(member.user.id)) {
        status = "online";
      }

      const topRole = getTopRole(member, roleIndex);
      grouped[status].push({
        member,
        topRoleColor: topRole?.color ?? null,
      });
    }

    return grouped;
  }, [members, roleIndex, typingSet]);

  const loadedCount = useMemo(
    () =>
      STATUS_ORDER.reduce(
        (sum, status) => sum + groupedMembers[status].length,
        0,
      ),
    [groupedMembers],
  );

  useEffect(() => {
    if (!debouncedSearch) {
      return;
    }

    scrollRef.current?.scrollTo({
      top: 0,
      behavior: "auto",
    });
  }, [debouncedSearch]);

  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (!entry?.isIntersecting) {
          return;
        }

        if (membersQuery.hasNextPage && !membersQuery.isFetchingNextPage) {
          void membersQuery.fetchNextPage();
        }
      },
      {
        root,
        rootMargin: "160px",
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    membersQuery.fetchNextPage,
    membersQuery.hasNextPage,
    membersQuery.isFetchingNextPage,
  ]);

  const showEmptyState =
    !membersQuery.isPending && !membersQuery.isError && loadedCount === 0;

  return (
    <aside className="flex h-full min-h-0 flex-col border-l bg-card">
      <div className="border-b px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Members</h3>
          <span className="text-xs text-muted-foreground">{loadedCount}</span>
        </div>
        <div className="relative mt-2">
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search members"
            className="pr-8"
          />
          {searchInput ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="absolute right-1 top-1/2 -translate-y-1/2"
              onClick={() => setSearchInput("")}
              aria-label="Clear member search"
              title="Clear"
            >
              <X className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {membersQuery.isPending ? <MemberListSkeleton /> : null}

        {membersQuery.isError ? (
          <p className="px-3 py-3 text-sm">Could not load members.</p>
        ) : null}

        {showEmptyState ? (
          <p className="px-3 py-3 text-sm">
            {debouncedSearch ? "No results." : "No members found."}
          </p>
        ) : null}

        {!membersQuery.isPending && !membersQuery.isError ? (
          <div className="px-2 pb-3">
            {STATUS_ORDER.map((status) => {
              const items = groupedMembers[status];
              if (items.length === 0) {
                return null;
              }

              return (
                <section key={status}>
                  <p className="px-1 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {STATUS_LABELS[status]} ({items.length})
                  </p>

                  <div className="space-y-0.5">
                    {items.map(({ member, topRoleColor }) => (
                      <MemberRow
                        key={member.user.id}
                        member={member}
                        status={status}
                        topRoleColor={topRoleColor}
                        currentUserId={currentUserId}
                        onOpenProfile={onOpenProfile}
                        onStartDm={onStartDm}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        ) : null}

        <div ref={sentinelRef} className="h-5" />

        {membersQuery.isFetchingNextPage ? (
          <p className="px-3 pb-3 text-xs text-muted-foreground">
            Loading more...
          </p>
        ) : null}
      </div>
    </aside>
  );
}

export default MemberList;
