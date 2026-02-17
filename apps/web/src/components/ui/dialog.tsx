import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

type DialogContextValue = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const DialogContext = React.createContext<DialogContextValue | null>(null);

const useDialogContext = (): DialogContextValue => {
  const context = React.useContext(DialogContext);
  if (!context) {
    throw new Error("Dialog components must be used inside Dialog.");
  }
  return context;
};

export const Dialog = ({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) => (
  <DialogContext.Provider value={{ open, onOpenChange }}>{children}</DialogContext.Provider>
);

export const DialogTrigger = ({
  asChild,
  children,
}: {
  asChild?: boolean;
  children: React.ReactNode;
}) => {
  const { onOpenChange } = useDialogContext();

  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children as React.ReactElement<{ onClick?: () => void }>, {
      onClick: () => onOpenChange(true),
    });
  }

  return (
    <button type="button" onClick={() => onOpenChange(true)}>
      {children}
    </button>
  );
};

export const DialogPortal = ({ children }: { children: React.ReactNode }) => <>{children}</>;

export const DialogOverlay = ({ className }: { className?: string }) => {
  const { open } = useDialogContext();
  if (!open) {
    return null;
  }

  return <div className={cn("fixed inset-0 z-50 bg-black/60", className)} />;
};

export const DialogContent = ({
  className,
  children,
  showClose = true,
}: {
  className?: string;
  children: React.ReactNode;
  showClose?: boolean;
}) => {
  const { open, onOpenChange } = useDialogContext();
  if (!open) {
    return null;
  }

  return (
    <DialogPortal>
      <DialogOverlay />
      <div className="fixed inset-0 z-50 grid place-items-center p-4">
        <div className={cn("w-full max-w-lg rounded-lg border bg-card p-6 shadow-xl", className)}>
          {showClose ? (
            <div className="mb-2 flex justify-end">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => onOpenChange(false)}
                aria-label="Close dialog"
              >
                <X />
              </Button>
            </div>
          ) : null}
          {children}
        </div>
      </div>
    </DialogPortal>
  );
};

export const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("mb-4 space-y-1", className)} {...props} />
);

export const DialogTitle = ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
  <h2 className={cn("text-lg font-semibold", className)} {...props} />
);

export const DialogDescription = ({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn("text-sm text-muted-foreground", className)} {...props} />
);

export const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("mt-4 flex items-center justify-end gap-2", className)} {...props} />
);

export const DialogClose = ({
  asChild,
  children,
}: {
  asChild?: boolean;
  children: React.ReactNode;
}) => {
  const { onOpenChange } = useDialogContext();

  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children as React.ReactElement<{ onClick?: () => void }>, {
      onClick: () => onOpenChange(false),
    });
  }

  return (
    <button type="button" onClick={() => onOpenChange(false)}>
      {children}
    </button>
  );
};
