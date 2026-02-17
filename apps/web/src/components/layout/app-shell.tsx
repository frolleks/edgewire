import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type AppShellProps = {
  children: ReactNode;
  className?: string;
};

export function AppShell({ children, className }: AppShellProps) {
  return (
    <div className="h-screen overflow-hidden bg-background">
      <div className={cn("h-full grid grid-cols-[72px_300px_1fr]", className)}>
        {children}
      </div>
    </div>
  );
}

export default AppShell;
