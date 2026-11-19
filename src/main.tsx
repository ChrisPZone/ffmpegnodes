import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { App, initApp } from "./App";
import { useGraph } from "./store/graph";

initApp();

// Dev-only handle for debugging from the browser console.
if (import.meta.env.DEV) (window as unknown as { __ffmpegnodes: unknown }).__ffmpegnodes = useGraph;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
