import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { api } from "@/lib/api";
import { getSessionUser } from "./session";

type AuthPageProps = {
  mode: "login" | "register";
};

export function AuthPage({ mode }: AuthPageProps) {
  const navigate = useNavigate();
  const session = authClient.useSession();
  const sessionUser = getSessionUser(session.data);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (sessionUser) {
      navigate("/app/channels/@me", { replace: true });
    }
  }, [navigate, sessionUser]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setIsSubmitting(true);

    try {
      if (mode === "login") {
        const result = (await authClient.signIn.email({
          email,
          password,
        })) as { error?: { message?: string } };

        if (result?.error) {
          throw new Error(result.error.message ?? "Sign in failed.");
        }
      } else {
        const signUpResult = (await authClient.signUp.email({
          email,
          password,
          name: displayName.trim() || username,
        })) as { error?: { message?: string } };

        if (signUpResult?.error) {
          throw new Error(signUpResult.error.message ?? "Sign up failed.");
        }

        await api.updateProfile({
          username,
          display_name: displayName,
        });
      }

      navigate("/app/channels/@me", { replace: true });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Authentication failed.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="h-screen grid place-items-center px-4 bg-background">
      <form
        className="w-full max-w-md rounded-2xl border bg-card p-8 shadow-sm"
        onSubmit={submit}
      >
        <h1 className="text-2xl font-semibold mb-2">
          {mode === "login" ? "Welcome Back" : "Create Account"}
        </h1>
        <p className="text-sm mb-6">
          {mode === "login"
            ? "Sign in to continue chatting."
            : "Create your account to start chatting."}
        </p>

        {mode === "register" ? (
          <>
            <Label className="mb-2 block" htmlFor="username">
              Username
            </Label>
            <Input
              id="username"
              required
              minLength={3}
              maxLength={32}
              pattern="[a-zA-Z0-9_]+"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="frolleks"
              className="mb-4"
            />

            <Label className="mb-2 block" htmlFor="display-name">
              Display Name
            </Label>
            <Input
              id="display-name"
              required
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Frolleks"
              className="mb-4"
            />
          </>
        ) : null}

        <Label className="mb-2 block" htmlFor="email">
          Email
        </Label>
        <Input
          id="email"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          className="mb-4"
        />

        <Label className="mb-2 block" htmlFor="password">
          Password
        </Label>
        <Input
          id="password"
          type="password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="********"
          className="mb-6"
        />

        <Button disabled={isSubmitting} type="submit" className="w-full">
          {isSubmitting
            ? "Please wait..."
            : mode === "login"
              ? "Sign In"
              : "Create Account"}
        </Button>

        <div className="mt-4 text-sm">
          {mode === "login" ? (
            <>
              Need an account?{" "}
              <Link className="hover:underline" to="/register">
                Register
              </Link>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <Link className="hover:underline" to="/login">
                Sign in
              </Link>
            </>
          )}
        </div>
      </form>
    </div>
  );
}

export default AuthPage;
