import express from "express";
const app = express();
app.use(express.static("dist/public"));
app.listen(5000, () => console.log("serving on port 5000"));
