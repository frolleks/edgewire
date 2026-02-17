import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";

export function JoinGuildPage() {
  const params = useParams<{ code: string }>();
  const code = params.code ?? "";
  const navigate = useNavigate();

  const inviteQuery = useQuery({
    queryKey: queryKeys.invite(code),
    queryFn: () => api.getInvite(code, true),
    enabled: Boolean(code),
  });

  const acceptMutation = useMutation({
    mutationFn: () => api.acceptInvite(code),
    onSuccess: ({ guildId, channelId }) => {
      navigate(`/app/channels/${guildId}/${channelId}`, { replace: true });
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Could not join guild.",
      );
    },
  });

  const invite = inviteQuery.data;

  return (
    <div className="h-screen grid place-items-center p-4 bg-background">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Server Invite</CardTitle>
          <CardDescription>
            Review the invite and accept to join.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {inviteQuery.isLoading ? <p>Loading invite...</p> : null}
          {!inviteQuery.isLoading && !invite ? (
            <p>Invite not found or expired.</p>
          ) : null}
          {invite ? (
            <div className="space-y-3">
              <div>
                <p className="text-sm">Guild</p>
                <p className="font-semibold">{invite.guild.name}</p>
              </div>
              <div>
                <p className="text-sm">Channel</p>
                <p className="font-semibold">#{invite.channel.name}</p>
              </div>
              <div>
                <p className="text-sm">Inviter</p>
                <p className="font-semibold">{invite.inviter.display_name}</p>
              </div>
              {invite.approximate_member_count !== undefined ? (
                <p className="text-sm">
                  Members: {invite.approximate_member_count} · Online:{" "}
                  {invite.approximate_presence_count ?? 0}
                </p>
              ) : null}
            </div>
          ) : null}
        </CardContent>
        <CardFooter className="flex gap-2 justify-end">
          <Button
            variant="outline"
            onClick={() => navigate("/app/channels/@me")}
          >
            Home
          </Button>
          <Button
            disabled={!invite || acceptMutation.isPending}
            onClick={() => acceptMutation.mutate()}
          >
            {acceptMutation.isPending ? "Joining..." : "Accept Invite"}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

export default JoinGuildPage;
