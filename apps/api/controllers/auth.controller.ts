import { z } from "zod";
import { fromZodError } from "zod-validation-error";
import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import jwt from "jsonwebtoken";

require("dotenv").config();

const prisma = new PrismaClient();

const authSchema = z.object({
  username: z.string().max(32),
  email: z.string().email(),
  password: z.string().min(8, { message: "Must be 8 or more characters long" }),
});

export const signup = async (req: Request, res: Response) => {
  try {
    const validate = await authSchema.safeParseAsync(req.body);
    const tokenBody = {
      username: req.body.username,
      email: req.body.email,
    };
    // @ts-ignore
    const token = jwt.sign(tokenBody, process.env.JWT_SIGN, {
      expiresIn: "1h",
    });

    if (!validate.success) {
      res.status(400).send(fromZodError(validate.error));
    } else {
      const passwordHash = await argon2.hash(req.body.password);

      await prisma.user.create({
        data: {
          username: req.body.username,
          email: req.body.email,
          password: passwordHash,
        },
      });

      const getId = await prisma.user.findUnique({
        where: {
          email: req.body.email,
        },
        select: {
          id: true,
        },
      });

      const id = getId?.id;

      res.cookie("token", token, {
        httpOnly: true,
        secure: true,
      });
      res.cookie("id", id, {
        httpOnly: true,
        secure: true,
      });
      res.status(201).json({ message: "Welcome!", token: token, id: id });
    }
  } catch (error) {
    res.status(500).json({ message: "Internal Server Error", error: error });
  }
};

export const signin = async (req: Request, res: Response) => {
  const getEmail = await prisma.user.findUnique({
    where: {
      email: req.body.email,
    },
    select: {
      email: true,
    },
  });
  const getUsername = await prisma.user.findUnique({
    where: {
      email: req.body.email,
    },
    select: {
      username: true,
    },
  });
  const getPassword = await prisma.user.findUnique({
    where: {
      email: req.body.email,
    },
    select: {
      password: true,
    },
  });
  const getId = await prisma.user.findUnique({
    where: {
      email: req.body.email,
    },
    select: {
      id: true,
    },
  });

  const passwordRegex = JSON.stringify(getPassword).replace(/[{}":]/g, "");

  const email = getEmail?.email;
  const username = getUsername?.username;
  const password = passwordRegex.replace(/password/g, "");
  const id = getId?.id;

  try {
    if (!email) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid email or password.",
      });
    }

    const verifyPassword = await argon2.verify(password, req.body.password);

    if (!verifyPassword) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Invalid email or password.",
      });
    } else {
      const verifyPassword = await argon2.verify(password, req.body.password);
      if (verifyPassword === true) {
        const body = {
          username: username,
          email: req.body.email,
        };
        // @ts-ignore
        const token = jwt.sign(body, process.env.JWT_SIGN, {
          expiresIn: "1h",
        });
        res.cookie("token", token, {
          httpOnly: true,
          secure: true,
        });
        res.cookie("id", id, {
          httpOnly: true,
          secure: true,
        });
        res
          .status(200)
          .json({ message: "Welcome back!", token: token, id: getId?.id });
      } else {
        res
          .status(400)
          .json({ error: "Bad Request", message: "Wrong email or password." });
      }
    }
  } catch (error) {
    res.status(500).json({ message: "Internal Server Error" });
    console.log(error);
  }
};
