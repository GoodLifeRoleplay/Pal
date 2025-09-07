import React from "react";
import { createRoot } from "react-dom/client";
import Dashboard from "./components/Dashboard";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing <div id='root'/>");
createRoot(rootEl).render(
  <React.StrictMode>
    <Dashboard />
  </React.StrictMode>
);
