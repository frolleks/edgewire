import express from "express";
import argon2 from "argon2";
import { z } from "zod";
import { fromZodError } from "zod-validation-error";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = express.Router();

require("dotenv").config();

const schema = z.object({
  username: z
    .string()
    .max(32, { message: "Must be 32 or fewer characters long" }),
  email: z.string().email({ message: "Invalid email address" }),
  password: z.string().min(8, { message: "Must be 8 or more characters long" }),
});

router.post("/signup", async (req, res) => {
  try {
    const validate = schema.safeParse(req.body);
    if (!validate.success) {
      res.status(400).send(fromZodError(validate.error));
    } else {
      const hash = await argon2.hash(req.body.password);
      const token = jwt.sign(
        { username: req.body.username, email: req.body.email, password: hash },
        // @ts-ignore
        process.env.JWT_PASS
      );
      await prisma.user.create({
        data: {
          username: req.body.username,
          email: req.body.email,
          password: hash,
        },
      });
      res.status(201).send({ message: "Welcome!", token: token });
    }
  } catch (error) {
    console.error(error);
    res.status(500);
  }
});

router.post("/login", async (req, res) => {
  const getUsername = await prisma.user.findUnique({
    where: {
      email: req.body.email,
    },
    select: {
      username: true,
    },
  });
  const getPasswordHash = await prisma.user.findUnique({
    where: {
      email: req.body.email,
    },
    select: {
      password: true,
    },
  });
  const hashRegex = JSON.stringify(getPasswordHash).replace(/[{}":]/g, "");
  const passwordHash = hashRegex.replace(/password/g, "");
  const verifyHash = await argon2.verify(passwordHash, req.body.password);
  try {
    const token = jwt.sign(
      {
        username: getUsername,
        email: req.body.email,
        password: passwordHash,
      },
      // @ts-ignore
      process.env.JWT_PASS
    );
    if (verifyHash === true) {
      res.status(200).send({ message: "Welcome back!", token: token });
    } else {
      res.status(400).send({ message: "Wrong email or password." });
    }
  } catch (error) {
    console.error(error);
    res.status(500);
  }
});

export default router;
