import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

require("dotenv").config();

const prisma = new PrismaClient();

export const createMessage = async (req: Request, res: Response) => {
  // const auth = req.headers.authorization;
  // if (!auth) {
  //   res.status(401).json({ message: "You must be logged into Edgewire." });
  // } else {
  // }
  const parts = req.url.split("/");
  const channelId = parts[parts.length - 2];
  const message = await prisma.message.create({
    data: {
      authorId: req.body.userId,
      content: req.body.content,
      channelId: channelId,
    },
  });
  res.status(201).json(message);
};

export const getMessagesFromChannel = async (req: Request, res: Response) => {
  const auth = req.headers.authorization;
  if (!auth) {
    res.status(401).json({ message: "You must be logged into Edgewire." });
  } else {
    const parts = req.url.split("/");
    const channelId = parts[parts.length - 1];
    const message = await prisma.channel.findUnique({
      where: {
        id: channelId,
      },
      select: {
        messages: true,
      },
    });
    res.status(200).json(message);
  }
};
