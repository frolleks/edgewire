import { Button } from "@/components/ui/button";

type VoiceEmptyStateProps = {
  title: string;
  message: string;
  onBack: () => void;
};

export function VoiceEmptyState({ title, message, onBack }: VoiceEmptyStateProps) {
  return (
    <div className="h-full grid place-items-center px-6 text-center">
      <div className="max-w-md space-y-3">
        <h2 className="text-xl font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{message}</p>
        <Button onClick={onBack}>Back to text</Button>
      </div>
    </div>
  );
}

export default VoiceEmptyState;
