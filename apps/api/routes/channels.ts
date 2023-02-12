import express from "express";
import { createChannel } from "../controllers/channel.controller";
import {
  createMessage,
  getMessagesFromChannel,
} from "../controllers/message.controller";

const router = express.Router();

router.post("/create", createChannel);
router.post("/:id/create", createMessage);
router.get("/:id", getMessagesFromChannel);
// router.post("/signin", signin);

export default router;
