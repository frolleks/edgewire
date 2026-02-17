import type { FormEvent } from "react";
import { Modal } from "@/components/layout/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type CreateGuildModalProps = {
  open: boolean;
  onClose: () => void;
  name: string;
  setName: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
  isSubmitting: boolean;
};

export function CreateGuildModal({
  open,
  onClose,
  name,
  setName,
  onSubmit,
  isSubmitting,
}: CreateGuildModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create Guild"
      description="Create a server with a default Text Channels category and #general."
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <Label htmlFor="guild-name">Guild Name</Label>
          <Input
            id="guild-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={100}
            required
            className="mt-2"
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Creating..." : "Create"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default CreateGuildModal;
