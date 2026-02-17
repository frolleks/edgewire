import type { ReactNode } from "react";

type AppShellProps = {
  children: ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="h-screen overflow-hidden bg-background">
      <div className="h-full grid grid-cols-[72px_300px_1fr]">{children}</div>
    </div>
  );
}

export default AppShell;
