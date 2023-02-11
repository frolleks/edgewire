import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth";
import channelRoutes from "./routes/channels";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// routes
app.use("/auth", authRoutes);
app.use("/channels", channelRoutes);

app.listen(4000, () => {
  console.log("hello from API!");
});
