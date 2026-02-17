type ScreenshareTileProps = {
  id: string;
  label: string;
  stream: MediaStream;
  focused: boolean;
  onFocus: () => void;
};

export function ScreenshareTile({ id, label, stream, focused, onFocus }: ScreenshareTileProps) {
  return (
    <button
      key={id}
      type="button"
      onClick={onFocus}
      className={`rounded-lg border bg-card p-2 text-left ${focused ? "ring-2 ring-primary" : ""}`}
    >
      <p className="mb-1 text-xs text-muted-foreground truncate">{label}</p>
      <video
        autoPlay
        muted
        playsInline
        className="h-44 w-full rounded bg-black object-contain"
        ref={node => {
          if (node && node.srcObject !== stream) {
            node.srcObject = stream;
          }
        }}
      />
    </button>
  );
}

export default ScreenshareTile;
