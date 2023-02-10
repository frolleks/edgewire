import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// routes
app.use("/auth", authRoutes);

app.listen(4000, () => {
  console.log("hello from API!");
});
