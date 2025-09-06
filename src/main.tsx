import React from "react";
import ReactDOM from "react-dom/client";
import Dashboard from "./components/Dashboard";

const rootEl = document.getElementById("root");
if (!rootEl) {
  const msg = document.createElement("div");
  msg.textContent = "No #root element!";
  msg.style.color = "white";
  document.body.appendChild(msg);
  throw new Error("Missing #root");
}

console.log("[boot] main.tsx mounted"); // visible in devtools console

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <Dashboard />
  </React.StrictMode>
);
