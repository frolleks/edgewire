import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

require("dotenv").config();

const prisma = new PrismaClient();

export const createChannel = async (req: Request, res: Response) => {
  const auth = req.headers.authorization;
  if (!auth) {
    res.status(401).json({ message: "You must be logged into Edgewire." });
  } else {
    const channel = await prisma.channel.create({
      data: {
        name: req.body.name,
        description: req.body.description,
      },
    });
    res.status(201).json({ message: "Channel successfully created!", channel });
  }
};

export const getChannel = async (req: Request, res: Response) => {
  const auth = req.headers.authorization;
  if (!auth) {
    res.status(401).json({ message: "You must be logged into Edgewire." });
  } else {
    const parts = req.url.split("/");
    const id = parts[parts.length - 1];
    const channel = await prisma.channel.findUnique({
      where: {
        id: id,
      },
    });
    if (!channel) {
      res.status(404).json({ message: "This channel doesn't exist." });
    } else {
      res.status(200).json({ channel });
    }
  }
};
