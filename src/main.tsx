import React from "react";
import ReactDOM from "react-dom/client";
import Dashboard from "./components/Dashboard";
import "./index.css"; // <-- DO NOT REMOVE

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Dashboard />
  </React.StrictMode>
);
