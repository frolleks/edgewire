import express from "express";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { fromZodError } from "zod-validation-error";
import jwt from "jsonwebtoken";
import { v4 as uuid } from "uuid";

require("dotenv").config();

const router = express.Router();
const prisma = new PrismaClient();

const schema = z.object({
  author: z.string(),
  content: z.string(),
});

router.post("/:id/:id", async (req, res) => {
  try {
    const auth = req.headers.authorization;
    // @ts-ignore
    jwt.verify(auth, process.env.JWT_PASS, async (error) => {
      if (!error) {
        const id = uuid();
        await prisma.message.create({
          data: {
            author: req.body.author,
            id: id,
            content: req.body.content,
          },
        });
        res.status(201).send({ message: "message posted!", id: id });
      } else {
        console.error(error);
        res.status(401).send({ message: "Invalid token" });
      }
    });
    const validate = schema.safeParse(req.body);
    if (!validate.success) {
      res.status(400).send(fromZodError(validate.error));
    } else if (!auth) {
      res
        .status(401)
        .send({ message: "You must be logged in to make this request." });
    }
  } catch (error) {
    console.error(error);
    res.status(500);
  }
});

router.get("/:id/:id", async (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (!auth) {
      res
        .status(401)
        .send({ message: "You must be logged in to make this request." });
    }
    // @ts-ignore
    jwt.verify(auth, process.env.JWT_PASS, async (error) => {
      if (!error) {
        const messages = await prisma.message.findMany({
          select: {
            author: true,
            id: true,
            content: true,
            createdAt: true,
          },
        });
        res.status(200).send({ messages: messages });
      } else {
        console.error(error);
        res.status(401).send({ message: "Invalid token" });
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500);
  }
});

export default router;
