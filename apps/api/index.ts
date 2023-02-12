import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import authRoutes from "./routes/auth";
import channelRoutes from "./routes/channels";

require("dotenv").config();

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors());
app.use(cookieParser(process.env.COOKIE_SIGN));

// routes
app.use("/auth", authRoutes);
app.use("/channels", channelRoutes);

app.listen(4000, () => {
  console.log("API UP!");
});
