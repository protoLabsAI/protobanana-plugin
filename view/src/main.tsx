import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { ready } from "./api";
import "./styles.css";

// Kick off the bearer + theme handshake before first paint; App re-awaits the
// same memoized promise, so there's no double handshake.
ready();

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
