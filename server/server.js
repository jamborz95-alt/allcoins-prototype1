import express from "express";
import cors from "cors";

const app = express();

app.use(cors({
  origin: [
    "https://jamborz95-alt.github.io",
    "http://localhost:5173"
  ]
}));

app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    app: "ALLCOINS",
    status: "running",
    message: "Allcoins server is ready"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "ALLCOINS",
    version: "1.0.0"
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Allcoins server started on port ${PORT}`);
});
