import { ChannelType, type GuildChannelPayload } from "@discord/types";
import type { FormEvent } from "react";
import { Modal } from "@/components/layout/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type CreateChannelModalProps = {
  open: boolean;
  onClose: () => void;
  type: "0" | "4";
  setType: (value: "0" | "4") => void;
  name: string;
  setName: (value: string) => void;
  parentId: string;
  setParentId: (value: string) => void;
  categories: GuildChannelPayload[];
  onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
  isSubmitting: boolean;
};

export function CreateChannelModal({
  open,
  onClose,
  type,
  setType,
  name,
  setName,
  parentId,
  setParentId,
  categories,
  onSubmit,
  isSubmitting,
}: CreateChannelModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create Channel"
      description="Create a category or text channel in this guild."
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <Label>Channel Type</Label>
          <Select value={type} onValueChange={(value) => setType(value as "0" | "4")}>
            <SelectTrigger className="w-full mt-2">
              <SelectValue placeholder="Select type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">Text Channel</SelectItem>
              <SelectItem value="4">Category</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="channel-name">Name</Label>
          <Input
            id="channel-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={100}
            required
            className="mt-2"
          />
        </div>

        {type === String(ChannelType.GUILD_TEXT) ? (
          <div>
            <Label>Parent Category</Label>
            <Select value={parentId} onValueChange={setParentId}>
              <SelectTrigger className="w-full mt-2">
                <SelectValue placeholder="No category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No category</SelectItem>
                {categories.map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

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

export default CreateChannelModal;
