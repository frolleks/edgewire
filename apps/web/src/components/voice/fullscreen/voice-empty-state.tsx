import { Button } from "@/components/ui/button";

type VoiceEmptyStateProps = {
  title: string;
  message: string;
  onBack: () => void;
  onRetry?: () => void;
};

export function VoiceEmptyState({
  title,
  message,
  onBack,
  onRetry,
}: VoiceEmptyStateProps) {
  return (
    <div className="grid h-full place-items-center bg-background px-6 text-center">
      <div className="max-w-md space-y-3 rounded-2xl border border-border/50 bg-card/70 p-6 shadow-lg">
        <h2 className="text-xl font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{message}</p>
        <div className="flex items-center justify-center gap-2">
          {onRetry ? (
            <Button variant="secondary" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
          <Button variant="outline" onClick={onBack}>
            Back
          </Button>
        </div>
      </div>
    </div>
  );
}

export default VoiceEmptyState;
