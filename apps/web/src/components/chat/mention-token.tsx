import { cn } from "@/lib/utils";

type MentionTokenProps = {
  label: string;
  onClick?: () => void;
  accentColor?: string;
  className?: string;
};

const baseClassName =
  "inline-flex items-center rounded bg-accent px-1 py-0.5 font-medium text-accent-foreground align-baseline";

export function MentionToken({
  label,
  onClick,
  accentColor,
  className,
}: MentionTokenProps) {
  const style = accentColor ? { color: accentColor } : undefined;

  if (onClick) {
    return (
      <button
        type="button"
        className={cn(baseClassName, "hover:underline", className)}
        style={style}
        onClick={onClick}
      >
        {label}
      </button>
    );
  }

  return (
    <span className={cn(baseClassName, className)} style={style}>
      {label}
    </span>
  );
}

export default MentionToken;
