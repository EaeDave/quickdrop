import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import TextSession from "./TextSession";
import { isTextRoute } from "./web-route";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

createRoot(root).render(
  <StrictMode>{isTextRoute() ? <TextSession /> : <App />}</StrictMode>,
);
