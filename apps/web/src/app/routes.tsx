import { Navigate, Route, Routes } from "react-router-dom";
import ProtectedRoute from "@/app/protected-route";
import AuthPage from "@/components/auth/auth-page";
import JoinGuildPage from "@/components/guilds/join-guild-page";
import UserSettingsPage from "@/components/user-settings-page";
import ChatApp from "@/pages/chat-app";

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />

      <Route element={<ProtectedRoute />}>
        <Route path="/app" element={<ChatApp />} />
        <Route path="/app/channels/@me" element={<ChatApp />} />
        <Route path="/app/channels/@me/:channelId" element={<ChatApp />} />
        <Route path="/app/channels/:guildId" element={<ChatApp />} />
        <Route path="/app/channels/:guildId/:channelId" element={<ChatApp />} />
        <Route path="/settings/*" element={<UserSettingsPage />} />
        <Route path="/invite/:code" element={<JoinGuildPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/app" replace />} />
    </Routes>
  );
}

export default AppRoutes;
