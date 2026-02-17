import type { MessagePayload, UserSummary } from "@discord/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import { type ChangeEvent, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { z } from "zod";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { authClient } from "@/lib/auth-client";
import { api, type CurrentUser, type CurrentUserSettings, type DmChannel, type GuildMember, type UserTheme } from "@/lib/api";
import { ApiError } from "@/lib/http";
import { queryKeys } from "@/lib/query-keys";
import { syncDocumentTheme } from "@/lib/theme";
import { completeUpload, initAvatarUpload, putToS3 } from "@/lib/uploads";

type SectionKey = "account" | "profile" | "appearance" | "privacy";

type AuthAccountClient = {
  changeEmail?: (input: { newEmail: string; callbackURL?: string }) => Promise<{ error?: { message?: string } }>;
  changePassword?: (input: {
    currentPassword: string;
    newPassword: string;
    revokeOtherSessions?: boolean;
  }) => Promise<{ error?: { message?: string } }>;
  deleteUser?: (input: { password?: string; callbackURL?: string }) => Promise<{ error?: { message?: string } }>;
  signOut: () => Promise<void>;
};

const authApi = authClient as unknown as AuthAccountClient;

const ACCOUNT_SCHEMA = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(2, "Username must be at least 2 characters.")
    .max(32, "Username must be at most 32 characters.")
    .regex(/^[a-z0-9_.]+$/, "Only lowercase letters, numbers, underscore and dot are allowed."),
  display_name: z
    .string()
    .trim()
    .min(1, "Display name is required.")
    .max(32, "Display name must be at most 32 characters."),
});

const PROFILE_SCHEMA = z.object({
  bio: z.string().max(190, "Bio must be at most 190 characters."),
  pronouns: z.string().max(32, "Pronouns must be at most 32 characters."),
  status: z.string().max(60, "Status must be at most 60 characters."),
  banner_url: z.string().max(2000, "Banner URL is too long."),
});

const APPEARANCE_SCHEMA = z.object({
  theme: z.enum(["system", "light", "dark"]),
  compact_mode: z.boolean(),
  show_timestamps: z.boolean(),
  locale: z.string().max(32, "Locale must be at most 32 characters."),
});

const CHANGE_EMAIL_SCHEMA = z.object({
  newEmail: z.string().trim().email("Enter a valid email address."),
});

const CHANGE_PASSWORD_SCHEMA = z
  .object({
    currentPassword: z.string().min(1, "Current password is required."),
    newPassword: z.string().min(8, "New password must be at least 8 characters."),
    confirmPassword: z.string().min(1, "Confirm your new password."),
    revokeOtherSessions: z.boolean(),
  })
  .refine(value => value.newPassword === value.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

const sections: Array<{ key: SectionKey; label: string; path: string }> = [
  { key: "account", label: "My Account", path: "/settings/account" },
  { key: "profile", label: "Profile", path: "/settings/profile" },
  { key: "appearance", label: "Appearance", path: "/settings/appearance" },
  { key: "privacy", label: "Privacy and Safety", path: "/settings/privacy" },
];

const getDisplayInitial = (displayName: string): string => displayName.trim().slice(0, 1).toUpperCase() || "?";

const normalizeSection = (pathname: string): SectionKey | null => {
  const section = pathname.split("/").filter(Boolean)[1];
  if (section === "account" || section === "profile" || section === "appearance" || section === "privacy") {
    return section;
  }
  return null;
};

const getFieldError = (
  errors: Array<{ path: (string | number)[]; message: string }> | undefined,
  field: string,
): string | undefined => errors?.find(issue => issue.path[0] === field)?.message;

const withUpdatedAuthor = (message: MessagePayload, user: UserSummary): MessagePayload =>
  message.author.id === user.id
    ? {
        ...message,
        author: user,
      }
    : message;

const patchUserCaches = (queryClient: ReturnType<typeof useQueryClient>, user: UserSummary): void => {
  queryClient.setQueryData<CurrentUser>(queryKeys.me, old =>
    old && old.id === user.id ? { ...old, ...user } : old,
  );

  queryClient.setQueryData<DmChannel[]>(queryKeys.dmChannels, old =>
    (old ?? []).map(channel => ({
      ...channel,
      recipients: channel.recipients.map(recipient =>
        recipient.id === user.id ? { ...recipient, ...user } : recipient,
      ),
      last_message: channel.last_message ? withUpdatedAuthor(channel.last_message, user) : channel.last_message,
    })),
  );

  queryClient.setQueriesData<InfiniteData<MessagePayload[]>>(
    { queryKey: ["messages"] },
    old =>
      old
        ? {
            ...old,
            pages: old.pages.map(page => page.map(message => withUpdatedAuthor(message, user))),
          }
        : old,
  );

  queryClient.setQueriesData<GuildMember[]>(
    { queryKey: ["guild-members"] },
    old =>
      old
        ? old.map(member =>
            member.user.id === user.id
              ? {
                  ...member,
                  user: {
                    ...member.user,
                    ...user,
                  },
                }
              : member,
          )
        : old,
  );
};

export default function UserSettingsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();

  const meQuery = useQuery({
    queryKey: queryKeys.me,
    queryFn: api.getMe,
  });

  const me = meQuery.data as CurrentUser | undefined;

  const activeSection = normalizeSection(location.pathname);

  useEffect(() => {
    if (activeSection === null) {
      navigate("/settings/account", { replace: true });
    }
  }, [activeSection, navigate]);

  const [accountDraft, setAccountDraft] = useState({
    username: "",
    display_name: "",
  });
  const [accountErrors, setAccountErrors] = useState<Record<string, string>>({});

  const [profileDraft, setProfileDraft] = useState({
    bio: "",
    pronouns: "",
    status: "",
    banner_url: "",
  });
  const [profileErrors, setProfileErrors] = useState<Record<string, string>>({});

  const [appearanceDraft, setAppearanceDraft] = useState<CurrentUserSettings>({
    theme: "system",
    compact_mode: false,
    show_timestamps: true,
    locale: "",
  });
  const [appearanceErrors, setAppearanceErrors] = useState<Record<string, string>>({});

  const [newEmail, setNewEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);

  const [passwordDraft, setPasswordDraft] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
    revokeOtherSessions: false,
  });
  const [passwordErrors, setPasswordErrors] = useState<Record<string, string>>({});

  const [avatarDialogOpen, setAvatarDialogOpen] = useState(false);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [isAvatarDragOver, setIsAvatarDragOver] = useState(false);

  useEffect(() => {
    if (!me) {
      return;
    }

    setAccountDraft({
      username: me.username,
      display_name: me.display_name,
    });

    setProfileDraft({
      bio: me.bio ?? "",
      pronouns: me.pronouns ?? "",
      status: me.status ?? "",
      banner_url: me.banner_url ?? "",
    });

    setAppearanceDraft({
      theme: me.settings.theme,
      compact_mode: me.settings.compact_mode,
      show_timestamps: me.settings.show_timestamps,
      locale: me.settings.locale ?? "",
    });
  }, [me]);

  useEffect(() => {
    return syncDocumentTheme(appearanceDraft.theme);
  }, [appearanceDraft.theme]);

  useEffect(() => {
    return () => {
      if (avatarPreview) {
        URL.revokeObjectURL(avatarPreview);
      }
    };
  }, [avatarPreview]);

  const accountMutation = useMutation({
    mutationFn: (payload: { username: string; display_name: string }) => api.updateProfile(payload),
    onSuccess: data => {
      patchUserCaches(queryClient, {
        id: data.id,
        username: data.username,
        display_name: data.display_name,
        avatar_url: data.avatar_url,
      });
      queryClient.setQueryData(queryKeys.me, data);
      toast.success("Account updated.");
      setAccountErrors({});
    },
    onError: error => {
      if (error instanceof ApiError && error.status === 409) {
        setAccountErrors({ username: "That username is already taken." });
        return;
      }
      toast.error(error instanceof Error ? error.message : "Failed to update account.");
    },
  });

  const profileMutation = useMutation({
    mutationFn: (payload: { bio: string | null; pronouns: string | null; status: string | null; banner_url: string | null }) =>
      api.updateProfile(payload),
    onSuccess: data => {
      patchUserCaches(queryClient, {
        id: data.id,
        username: data.username,
        display_name: data.display_name,
        avatar_url: data.avatar_url,
      });
      queryClient.setQueryData(queryKeys.me, data);
      toast.success("Profile updated.");
      setProfileErrors({});
    },
    onError: error => {
      toast.error(error instanceof Error ? error.message : "Failed to update profile.");
    },
  });

  const settingsMutation = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: data => {
      queryClient.setQueryData<CurrentUser | undefined>(queryKeys.me, old =>
        old
          ? {
              ...old,
              settings: data,
            }
          : old,
      );
      toast.success("Appearance preferences saved.");
      setAppearanceErrors({});
    },
    onError: error => {
      toast.error(error instanceof Error ? error.message : "Failed to save settings.");
    },
  });

  const changeEmailMutation = useMutation({
    mutationFn: async (nextEmail: string) => {
      if (!authApi.changeEmail) {
        throw new Error("Email change is not available.");
      }

      const result = await authApi.changeEmail({
        newEmail: nextEmail,
        callbackURL: `${window.location.origin}/settings/account`,
      });

      if (result?.error?.message) {
        throw new Error(result.error.message);
      }
    },
    onSuccess: () => {
      setEmailError(null);
      setNewEmail("");
      toast.success("Email change requested. Check your email if verification is enabled.");
    },
    onError: error => {
      setEmailError(error instanceof Error ? error.message : "Email change failed.");
      toast.error(error instanceof Error ? error.message : "Email change failed.");
    },
  });

  const changePasswordMutation = useMutation({
    mutationFn: async (payload: {
      currentPassword: string;
      newPassword: string;
      revokeOtherSessions: boolean;
    }) => {
      if (!authApi.changePassword) {
        throw new Error("Password change is not available.");
      }

      const result = await authApi.changePassword(payload);
      if (result?.error?.message) {
        throw new Error(result.error.message);
      }
    },
    onSuccess: () => {
      setPasswordErrors({});
      setPasswordDraft({
        currentPassword: "",
        newPassword: "",
        confirmPassword: "",
        revokeOtherSessions: false,
      });
      toast.success("Password updated.");
    },
    onError: error => {
      toast.error(error instanceof Error ? error.message : "Password change failed.");
    },
  });

  const avatarMutation = useMutation({
    mutationFn: async (file: File) => {
      const init = await initAvatarUpload(file);
      await putToS3(init.put_url, file, init.headers);
      const completed = await completeUpload(init.upload_id);

      if (completed.kind !== "avatar") {
        throw new Error("Avatar upload did not complete correctly.");
      }

      return completed.user;
    },
    onSuccess: user => {
      patchUserCaches(queryClient, user);
      queryClient.setQueryData<CurrentUser | undefined>(queryKeys.me, old =>
        old
          ? {
              ...old,
              ...user,
            }
          : old,
      );
      setAvatarDialogOpen(false);
      setAvatarFile(null);
      if (avatarPreview) {
        URL.revokeObjectURL(avatarPreview);
      }
      setAvatarPreview(null);
      toast.success("Avatar updated.");
    },
    onError: error => {
      toast.error(error instanceof Error ? error.message : "Avatar upload failed.");
    },
  });

  const sectionTitle = useMemo(() => {
    if (!activeSection) {
      return "My Account";
    }

    return sections.find(section => section.key === activeSection)?.label ?? "My Account";
  }, [activeSection]);

  const openAvatarDialog = (): void => {
    setAvatarDialogOpen(true);
    setAvatarFile(null);
    if (avatarPreview) {
      URL.revokeObjectURL(avatarPreview);
      setAvatarPreview(null);
    }
  };

  const onAvatarFileSelected = (file: File | null): void => {
    setAvatarFile(file);
    if (avatarPreview) {
      URL.revokeObjectURL(avatarPreview);
    }
    setAvatarPreview(file ? URL.createObjectURL(file) : null);
  };

  const onAvatarInputChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0] ?? null;
    onAvatarFileSelected(file);
  };

  const onSignOut = async (): Promise<void> => {
    await authApi.signOut();
    queryClient.clear();
    navigate("/login", { replace: true });
  };

  if (activeSection === null) {
    return null;
  }

  if (meQuery.isPending) {
    return <div className="h-screen grid place-items-center">Loading settings...</div>;
  }

  if (!me) {
    return <Navigate to="/login" replace />;
  }

  const accountPanel = (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Account Details</CardTitle>
          <CardDescription>Manage your display identity in chats and mentions.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Avatar className="h-14 w-14">
              {me.avatar_url ? <AvatarImage src={me.avatar_url} alt={`${me.display_name} avatar`} /> : null}
              <AvatarFallback>{getDisplayInitial(me.display_name)}</AvatarFallback>
            </Avatar>
            <div>
              <p className="font-medium">{me.display_name}</p>
              <p className="text-sm text-muted-foreground">@{me.username}</p>
              <p className="text-xs text-muted-foreground">{me.email ?? "No email available"}</p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="settings-display-name">Display Name</Label>
            <Input
              id="settings-display-name"
              value={accountDraft.display_name}
              onChange={event => setAccountDraft(previous => ({ ...previous, display_name: event.target.value }))}
              maxLength={32}
            />
            {accountErrors.display_name ? <p className="text-xs text-destructive">{accountErrors.display_name}</p> : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="settings-username">Username</Label>
            <Input
              id="settings-username"
              value={accountDraft.username}
              onChange={event => setAccountDraft(previous => ({ ...previous, username: event.target.value }))}
              maxLength={32}
            />
            {accountErrors.username ? <p className="text-xs text-destructive">{accountErrors.username}</p> : null}
          </div>
        </CardContent>
        <CardFooter className="justify-end">
          <Button
            disabled={accountMutation.isPending}
            onClick={() => {
              const parsed = ACCOUNT_SCHEMA.safeParse(accountDraft);
              if (!parsed.success) {
                setAccountErrors({
                  username: getFieldError(parsed.error.issues, "username") ?? "",
                  display_name: getFieldError(parsed.error.issues, "display_name") ?? "",
                });
                return;
              }

              accountMutation.mutate({
                username: parsed.data.username,
                display_name: parsed.data.display_name,
              });
            }}
          >
            {accountMutation.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Change Email</CardTitle>
          <CardDescription>Use Better Auth email change flow.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="settings-new-email">New Email</Label>
          <Input
            id="settings-new-email"
            type="email"
            value={newEmail}
            onChange={event => setNewEmail(event.target.value)}
            placeholder="you@example.com"
          />
          {emailError ? <p className="text-xs text-destructive">{emailError}</p> : null}
        </CardContent>
        <CardFooter className="justify-end">
          <Button
            disabled={changeEmailMutation.isPending}
            onClick={() => {
              const parsed = CHANGE_EMAIL_SCHEMA.safeParse({ newEmail });
              if (!parsed.success) {
                setEmailError(parsed.error.issues[0]?.message ?? "Invalid email.");
                return;
              }

              changeEmailMutation.mutate(parsed.data.newEmail);
            }}
          >
            {changeEmailMutation.isPending ? "Submitting..." : "Change Email"}
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Change Password</CardTitle>
          <CardDescription>Update your password and optionally revoke other sessions.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="settings-current-password">Current Password</Label>
            <Input
              id="settings-current-password"
              type="password"
              value={passwordDraft.currentPassword}
              onChange={event =>
                setPasswordDraft(previous => ({ ...previous, currentPassword: event.target.value }))
              }
            />
            {passwordErrors.currentPassword ? (
              <p className="text-xs text-destructive">{passwordErrors.currentPassword}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="settings-new-password">New Password</Label>
            <Input
              id="settings-new-password"
              type="password"
              value={passwordDraft.newPassword}
              onChange={event => setPasswordDraft(previous => ({ ...previous, newPassword: event.target.value }))}
            />
            {passwordErrors.newPassword ? <p className="text-xs text-destructive">{passwordErrors.newPassword}</p> : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="settings-confirm-password">Confirm New Password</Label>
            <Input
              id="settings-confirm-password"
              type="password"
              value={passwordDraft.confirmPassword}
              onChange={event =>
                setPasswordDraft(previous => ({ ...previous, confirmPassword: event.target.value }))
              }
            />
            {passwordErrors.confirmPassword ? (
              <p className="text-xs text-destructive">{passwordErrors.confirmPassword}</p>
            ) : null}
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={passwordDraft.revokeOtherSessions}
              onChange={event =>
                setPasswordDraft(previous => ({ ...previous, revokeOtherSessions: event.target.checked }))
              }
            />
            Log out of other sessions
          </label>
        </CardContent>
        <CardFooter className="justify-end">
          <Button
            disabled={changePasswordMutation.isPending}
            onClick={() => {
              const parsed = CHANGE_PASSWORD_SCHEMA.safeParse(passwordDraft);
              if (!parsed.success) {
                setPasswordErrors({
                  currentPassword: getFieldError(parsed.error.issues, "currentPassword") ?? "",
                  newPassword: getFieldError(parsed.error.issues, "newPassword") ?? "",
                  confirmPassword: getFieldError(parsed.error.issues, "confirmPassword") ?? "",
                });
                return;
              }

              changePasswordMutation.mutate({
                currentPassword: parsed.data.currentPassword,
                newPassword: parsed.data.newPassword,
                revokeOtherSessions: parsed.data.revokeOtherSessions,
              });
            }}
          >
            {changePasswordMutation.isPending ? "Updating..." : "Change Password"}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );

  const profilePanel = (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Avatar</CardTitle>
          <CardDescription>Change your profile picture.</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Avatar className="h-16 w-16">
              {me.avatar_url ? <AvatarImage src={me.avatar_url} alt={`${me.display_name} avatar`} /> : null}
              <AvatarFallback>{getDisplayInitial(me.display_name)}</AvatarFallback>
            </Avatar>
            <div>
              <p className="font-medium">{me.display_name}</p>
              <p className="text-sm text-muted-foreground">PNG, JPEG, WEBP</p>
            </div>
          </div>
          <Button onClick={openAvatarDialog}>Change Avatar</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Profile Details</CardTitle>
          <CardDescription>Customize your banner and about fields.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="settings-banner-url">Banner Image URL</Label>
            <Input
              id="settings-banner-url"
              placeholder="https://..."
              value={profileDraft.banner_url}
              onChange={event => setProfileDraft(previous => ({ ...previous, banner_url: event.target.value }))}
            />
            {profileErrors.banner_url ? <p className="text-xs text-destructive">{profileErrors.banner_url}</p> : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="settings-bio">About Me</Label>
            <Textarea
              id="settings-bio"
              value={profileDraft.bio}
              onChange={event => setProfileDraft(previous => ({ ...previous, bio: event.target.value }))}
              maxLength={190}
            />
            <p className="text-xs text-muted-foreground">{profileDraft.bio.length}/190</p>
            {profileErrors.bio ? <p className="text-xs text-destructive">{profileErrors.bio}</p> : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="settings-pronouns">Pronouns</Label>
            <Input
              id="settings-pronouns"
              value={profileDraft.pronouns}
              onChange={event => setProfileDraft(previous => ({ ...previous, pronouns: event.target.value }))}
              maxLength={32}
            />
            {profileErrors.pronouns ? <p className="text-xs text-destructive">{profileErrors.pronouns}</p> : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="settings-status">Status Text</Label>
            <Input
              id="settings-status"
              value={profileDraft.status}
              onChange={event => setProfileDraft(previous => ({ ...previous, status: event.target.value }))}
              maxLength={60}
            />
            {profileErrors.status ? <p className="text-xs text-destructive">{profileErrors.status}</p> : null}
          </div>
        </CardContent>
        <CardFooter className="justify-end">
          <Button
            disabled={profileMutation.isPending}
            onClick={() => {
              const parsed = PROFILE_SCHEMA.safeParse(profileDraft);
              if (!parsed.success) {
                setProfileErrors({
                  bio: getFieldError(parsed.error.issues, "bio") ?? "",
                  pronouns: getFieldError(parsed.error.issues, "pronouns") ?? "",
                  status: getFieldError(parsed.error.issues, "status") ?? "",
                  banner_url: getFieldError(parsed.error.issues, "banner_url") ?? "",
                });
                return;
              }

              profileMutation.mutate({
                bio: parsed.data.bio.trim() || null,
                pronouns: parsed.data.pronouns.trim() || null,
                status: parsed.data.status.trim() || null,
                banner_url: parsed.data.banner_url.trim() || null,
              });
            }}
          >
            {profileMutation.isPending ? "Saving..." : "Save Profile"}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );

  const appearancePanel = (
    <Card>
      <CardHeader>
        <CardTitle>Appearance & Preferences</CardTitle>
        <CardDescription>Control visual theme and message display options.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label>Theme</Label>
          <Select
            value={appearanceDraft.theme}
            onValueChange={value =>
              setAppearanceDraft(previous => ({
                ...previous,
                theme: value as UserTheme,
              }))
            }
          >
            <SelectTrigger className="w-full max-w-xs">
              <SelectValue placeholder="Select theme" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
            </SelectContent>
          </Select>
          {appearanceErrors.theme ? <p className="text-xs text-destructive">{appearanceErrors.theme}</p> : null}
        </div>

        <div className="flex items-center justify-between gap-4 rounded-md border p-3">
          <div>
            <p className="text-sm font-medium">Compact mode</p>
            <p className="text-xs text-muted-foreground">Use denser message rows in chat.</p>
          </div>
          <Switch
            checked={appearanceDraft.compact_mode}
            onCheckedChange={checked =>
              setAppearanceDraft(previous => ({
                ...previous,
                compact_mode: checked,
              }))
            }
          />
        </div>

        <div className="flex items-center justify-between gap-4 rounded-md border p-3">
          <div>
            <p className="text-sm font-medium">Show timestamps</p>
            <p className="text-xs text-muted-foreground">Show message time in chat headers.</p>
          </div>
          <Switch
            checked={appearanceDraft.show_timestamps}
            onCheckedChange={checked =>
              setAppearanceDraft(previous => ({
                ...previous,
                show_timestamps: checked,
              }))
            }
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="settings-locale">Locale</Label>
          <Input
            id="settings-locale"
            value={appearanceDraft.locale ?? ""}
            onChange={event =>
              setAppearanceDraft(previous => ({
                ...previous,
                locale: event.target.value,
              }))
            }
            placeholder="en-US"
          />
          {appearanceErrors.locale ? <p className="text-xs text-destructive">{appearanceErrors.locale}</p> : null}
        </div>
      </CardContent>
      <CardFooter className="justify-end">
        <Button
          disabled={settingsMutation.isPending}
          onClick={() => {
            const parsed = APPEARANCE_SCHEMA.safeParse(appearanceDraft);
            if (!parsed.success) {
              setAppearanceErrors({
                theme: getFieldError(parsed.error.issues, "theme") ?? "",
                locale: getFieldError(parsed.error.issues, "locale") ?? "",
              });
              return;
            }

            settingsMutation.mutate({
              theme: parsed.data.theme,
              compact_mode: parsed.data.compact_mode,
              show_timestamps: parsed.data.show_timestamps,
              locale: parsed.data.locale.trim() || null,
            });
          }}
        >
          {settingsMutation.isPending ? "Saving..." : "Save Preferences"}
        </Button>
      </CardFooter>
    </Card>
  );

  const privacyPanel = (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Privacy and Safety</CardTitle>
          <CardDescription>Placeholder for upcoming privacy controls.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No privacy controls are implemented yet.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Danger Zone</CardTitle>
          <CardDescription>Delete account is disabled unless enabled in Better Auth server config.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" disabled>
            Delete Account (Disabled)
          </Button>
        </CardContent>
      </Card>
    </div>
  );

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto flex w-full max-w-7xl gap-0 px-3 py-6 sm:px-6 lg:px-8">
        <aside className="w-64 shrink-0 border-r pr-4">
          <div className="space-y-1">
            {sections.map(section => (
              <Button
                key={section.key}
                variant={activeSection === section.key ? "secondary" : "ghost"}
                className="w-full justify-start"
                onClick={() => navigate(section.path)}
              >
                {section.label}
              </Button>
            ))}
          </div>

          <div className="mt-6 border-t pt-4">
            <Button variant="destructive" className="w-full justify-start" onClick={() => onSignOut().catch(() => undefined)}>
              Log Out
            </Button>
          </div>
        </aside>

        <main className="min-w-0 flex-1 pl-4 sm:pl-6">
          <div className="mb-4">
            <h1 className="text-2xl font-semibold">{sectionTitle}</h1>
          </div>

          {activeSection === "account" ? accountPanel : null}
          {activeSection === "profile" ? profilePanel : null}
          {activeSection === "appearance" ? appearancePanel : null}
          {activeSection === "privacy" ? privacyPanel : null}
        </main>
      </div>

      <Dialog open={avatarDialogOpen} onOpenChange={setAvatarDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change Avatar</DialogTitle>
            <DialogDescription>Drop an image or choose a file to upload.</DialogDescription>
          </DialogHeader>

          <div
            className={`rounded-md border-2 border-dashed p-4 text-center ${
              isAvatarDragOver ? "border-primary bg-accent" : "border-border"
            }`}
            onDragOver={event => {
              event.preventDefault();
              setIsAvatarDragOver(true);
            }}
            onDragLeave={event => {
              event.preventDefault();
              setIsAvatarDragOver(false);
            }}
            onDrop={event => {
              event.preventDefault();
              setIsAvatarDragOver(false);
              const file = event.dataTransfer.files?.[0] ?? null;
              onAvatarFileSelected(file);
            }}
          >
            <p className="text-sm">Drag and drop an image here</p>
            <p className="mt-1 text-xs text-muted-foreground">PNG, JPEG, WEBP</p>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="mt-3 block w-full text-sm"
              onChange={onAvatarInputChange}
            />
          </div>

          {avatarPreview ? (
            <div className="mt-4 flex justify-center">
              <Avatar className="h-24 w-24">
                <AvatarImage src={avatarPreview} alt="Avatar preview" />
                <AvatarFallback>{getDisplayInitial(me.display_name)}</AvatarFallback>
              </Avatar>
            </div>
          ) : null}

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              disabled={!avatarFile || avatarMutation.isPending}
              onClick={() => {
                if (!avatarFile) {
                  return;
                }
                avatarMutation.mutate(avatarFile);
              }}
            >
              {avatarMutation.isPending ? "Uploading..." : "Save Avatar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
