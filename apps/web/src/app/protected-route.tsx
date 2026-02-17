import { Navigate, Outlet } from "react-router-dom";
import { authClient } from "@/lib/auth-client";
import { getSessionUser } from "@/components/auth/session";

export function ProtectedRoute() {
  const session = authClient.useSession();
  const sessionUser = getSessionUser(session.data);

  if (session.isPending) {
    return <div className="h-screen grid place-items-center">Loading...</div>;
  }

  if (!sessionUser) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}

export default ProtectedRoute;
